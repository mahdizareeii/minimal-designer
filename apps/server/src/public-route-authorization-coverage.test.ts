import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DIRECT_AUTHORIZATION_COVERAGE_SUMMARY,
  DIRECT_AUTHORIZATION_ROUTE_EVIDENCE,
  DIRECT_AUTHORIZATION_ROUTE_KEYS,
  UNCOVERED_DIRECT_AUTHORIZATION_ROUTES,
} from "./public-route-authorization-coverage.js";
import { PROTECTED_NON_MCP_ROUTE_CONTRACTS } from "./public-route-contract.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("direct protected-route authorization evidence", () => {
  it("keeps the executable covered/remaining count synchronized with the protected route contract", () => {
    expect(DIRECT_AUTHORIZATION_COVERAGE_SUMMARY).toEqual({
      total: 124,
      covered: 124,
      remaining: 0,
    });
    expect(DIRECT_AUTHORIZATION_ROUTE_KEYS.length).toBe(DIRECT_AUTHORIZATION_ROUTE_EVIDENCE.length);
    expect(DIRECT_AUTHORIZATION_ROUTE_EVIDENCE.length + UNCOVERED_DIRECT_AUTHORIZATION_ROUTES.length)
      .toBe(PROTECTED_NON_MCP_ROUTE_CONTRACTS.size);
  });

  it("binds every covered route to a checked-in behavioral test file", () => {
    for (const entry of DIRECT_AUTHORIZATION_ROUTE_EVIDENCE) {
      expect(PROTECTED_NON_MCP_ROUTE_CONTRACTS.get(entry.key)).toMatchObject({
        family: entry.family,
        authorization: entry.authorization,
      });
      expect(existsSync(path.join(repositoryRoot, entry.testFile)), entry.testFile).toBe(true);
    }
  });

  it("keeps the remaining route list unique, ordered, and disjoint from direct evidence", () => {
    const remainingKeys = UNCOVERED_DIRECT_AUTHORIZATION_ROUTES.map((entry) => entry.key);
    expect(new Set(remainingKeys).size).toBe(remainingKeys.length);
    expect(remainingKeys).toEqual([...remainingKeys].sort((left, right) => {
      const leftIndex = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.keys()].indexOf(left);
      const rightIndex = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.keys()].indexOf(right);
      return leftIndex - rightIndex;
    }));
    for (const key of remainingKeys) expect(DIRECT_AUTHORIZATION_ROUTE_KEYS).not.toContain(key);
  });
});
