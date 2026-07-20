import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
});
