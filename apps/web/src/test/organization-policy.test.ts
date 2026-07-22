import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCodexConnection,
  organizationConfigurationUrl,
  readOrganizationPolicy,
  updateOrganizationPolicy,
} from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organization policy administration contract", () => {
  it("reads the strict policy and saves it with the exact configuration hash", async () => {
    const policy = { schemaVersion: 1, agents: { enabled: true } };
    const response = {
      organizationPolicy: {
        organizationId: "organization_legacy",
        organizationName: "FormaSpec workspace",
        policy,
        policyHash: "a".repeat(64),
        configurationHash: "b".repeat(64),
        source: "default",
        diagnostics: [],
        updatedAt: "2026-07-20T12:00:00.000Z",
      },
    };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        organizationPolicy: { ...response.organizationPolicy, source: "stored", configurationHash: "c".repeat(64) },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const current = await readOrganizationPolicy();
    expect(current.policy).toEqual(policy);
    const updated = await updateOrganizationPolicy(current.configurationHash, policy);
    expect(updated.source).toBe("stored");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/organization/policy");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/organization/policy");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedConfigurationHash: "b".repeat(64),
      policy,
    });
  });

  it("uses the fixed secret-free configuration-as-code download path", () => {
    expect(organizationConfigurationUrl()).toBe("/api/organization/configuration");
  });

  it("keeps automatic Codex grants out of human redesign decisions even when policy allows them", async () => {
    const allowedScopes = [
      "organization_policy:read",
      "context:write",
      "design:read",
      "design:preview",
      "design:write",
      "product_spec:read",
      "product_spec:preview",
      "product_spec:write",
      "planning:read",
      "planning:write",
      "task:read",
      "task:create",
      "task:claim",
      "task:update",
      "design_system:read",
      "workspace:inventory:read",
      "workspace:inventory:write",
      "implementation_mapping:read",
      "implementation_mapping:write",
      "handoff:read",
      "redesign:read",
      "redesign:assessment",
      "redesign:review",
      "redesign:interview",
      "redesign:proposal",
      "redesign:design",
      "redesign:handoff",
      "redesign:approve",
      "redesign:implement",
      "redesign:cancel",
    ];
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        organizationPolicy: {
          organizationId: "organization_legacy",
          organizationName: "FormaSpec workspace",
          policy: {
            agents: {
              enabled: true,
              allowedAdapters: ["codex"],
              allowedScopes,
              maximumExpirySeconds: 86_400,
              requireProjectRestriction: false,
            },
          },
          policyHash: "a".repeat(64),
          configurationHash: "b".repeat(64),
          source: "stored",
          diagnostics: [],
          updatedAt: "2026-07-20T12:00:00.000Z",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connection: { id: "connection_codex_default", scopes: [] },
        nonce: "fspair_codex_default",
        expiresAt: "2026-07-21T12:00:00.000Z",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));

    await createCodexConnection();
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/agent-connections");
    const requestBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as { displayName: string; scopes: string[] };
    expect(requestBody.displayName).toBe("Codex — FormaSpec");
    expect(requestBody.scopes).toContain("implementation_mapping:read");
    expect(requestBody.scopes).toContain("implementation_mapping:write");
    expect(requestBody.scopes).toContain("redesign:handoff");
    expect(requestBody.scopes).not.toContain("redesign:approve");
    expect(requestBody.scopes).not.toContain("redesign:implement");
    expect(requestBody.scopes).not.toContain("redesign:cancel");
  });
});
