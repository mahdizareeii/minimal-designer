import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inventoryForUpload, scanRepository } from "./inventory.js";
import {
  assertInventoryMatchesPolicy,
  persistRepositoryInventory,
  readRepositoryScanPolicy,
  repositoryPolicyConnectionFromEnvironment,
} from "./policy.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-workspace-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function policyResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    organizationPolicy: {
      policy: {
        repositories: {
          enabled: true,
          allowedPlatforms: ["web", "generic-git"],
          requireExplicitGrant: true,
          readOnlyByDefault: true,
          maximumInventoryBytes: 1_048_576,
          maximumInventoryEntities: 10_000,
          excludedPatterns: [".env", "**/private/**"],
          ...overrides,
        },
      },
    },
  });
}

describe("Workspace Bridge organization policy", () => {
  it("derives a safe server connection and automatically loads repository exclusions", async () => {
    expect(repositoryPolicyConnectionFromEnvironment({
      FORMASPEC_UPSTREAM_MCP_URL: "http://127.0.0.1:4310/mcp",
      FORMASPEC_API_TOKEN: "server-policy-token",
    })).toEqual({ mcpUrl: "http://127.0.0.1:4310/mcp", bearerToken: "server-policy-token" });
    expect(() => repositoryPolicyConnectionFromEnvironment({ FORMASPEC_API_URL: "http://company.example.test" }))
      .toThrow("HTTPS, or HTTP on loopback");

    let observedAuthorization: string | null = null;
    const policy = await readRepositoryScanPolicy({
      apiUrl: "https://formaspec.example.test",
      bearerToken: "server-policy-token",
    }, {
      fetchImplementation: (async (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get("authorization");
        return policyResponse();
      }) as typeof fetch,
    });
    expect(observedAuthorization).toBe("Bearer server-policy-token");
    expect(policy.excludedPatterns).toEqual([".env", "**/private/**"]);

    let observedMcpRequest: Record<string, unknown> | null = null;
    const throughBridge = await readRepositoryScanPolicy({
      mcpUrl: "http://127.0.0.1:4312/mcp",
    }, {
      fetchImplementation: (async (_input, init) => {
        observedMcpRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          jsonrpc: "2.0",
          id: "formaspec-workspace-policy",
          result: {
            structuredContent: {
              ok: true,
              organizationPolicy: (await policyResponse().json() as {
                organizationPolicy: Record<string, unknown>;
              }).organizationPolicy,
            },
          },
        });
      }) as typeof fetch,
    });
    expect(observedMcpRequest).toMatchObject({
      method: "tools/call",
      params: { name: "organization_policy_read", arguments: { format: "json" } },
    });
    expect(throughBridge).toEqual(policy);

    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "README.md"), "Workspace inventory fixture\n");
    const upload = inventoryForUpload(await scanRepository(root, { excludedPatterns: policy.excludedPatterns }));
    let uploadedArguments: Record<string, unknown> | null = null;
    const persisted = await persistRepositoryInventory({ mcpUrl: "http://127.0.0.1:4312/mcp" }, upload, {
      fetchImplementation: (async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          params?: { arguments?: Record<string, unknown> };
        };
        uploadedArguments = request.params?.arguments ?? null;
        return Response.json({
          jsonrpc: "2.0",
          id: "formaspec-workspace-inventory",
          result: {
            structuredContent: {
              ok: true,
              inventory: {
                id: `inventory_${"1".repeat(32)}`,
                repositoryFingerprint: upload.repositoryFingerprint,
                inventoryHash: "2".repeat(64),
                status: "active",
                deduplicated: false,
                createdAt: "2026-07-20T12:00:00.000Z",
              },
            },
          },
        });
      }) as typeof fetch,
    });
    expect(uploadedArguments).toEqual({ inventory: upload });
    expect(persisted).toMatchObject({
      id: `inventory_${"1".repeat(32)}`,
      repositoryFingerprint: upload.repositoryFingerprint,
      status: "active",
    });
  });

  it("fails closed for disabled or malformed repository policy", async () => {
    await expect(readRepositoryScanPolicy({ apiUrl: "http://127.0.0.1:4310" }, {
      fetchImplementation: (async () => policyResponse({ enabled: false })) as typeof fetch,
    })).rejects.toThrow("disabled or not read-only");
    await expect(readRepositoryScanPolicy({ apiUrl: "http://127.0.0.1:4310" }, {
      fetchImplementation: (async () => policyResponse({ excludedPatterns: ["valid", "valid"] })) as typeof fetch,
    })).rejects.toThrow("duplicated");

    const oversizedChunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 33; index += 1) controller.enqueue(new Uint8Array(64 * 1024));
        controller.close();
      },
    });
    await expect(readRepositoryScanPolicy({ apiUrl: "http://127.0.0.1:4310" }, {
      fetchImplementation: (async () => new Response(oversizedChunkedBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    })).rejects.toThrow("bounded response limit");
  });

  it("rejects stale policy metadata, disallowed platforms, and bounded upload violations", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "App.tsx"), "export function App() { return null; }\n");
    const policy = {
      excludedPatterns: ["**/private/**"],
      allowedPlatforms: ["web"] as const,
      maximumInventoryBytes: 1_048_576,
      maximumInventoryEntities: 10_000,
    };
    const inventory = await scanRepository(root, { excludedPatterns: policy.excludedPatterns });
    expect(() => assertInventoryMatchesPolicy(inventory, { ...policy, allowedPlatforms: [...policy.allowedPlatforms] }))
      .not.toThrow();
    expect(() => assertInventoryMatchesPolicy(inventory, {
      ...policy,
      excludedPatterns: ["**/private/**", "**/internal/**"],
      allowedPlatforms: [...policy.allowedPlatforms],
    })).toThrow("policy changed");
    expect(() => assertInventoryMatchesPolicy(inventory, {
      ...policy,
      allowedPlatforms: ["android"],
    })).toThrow("disallowed");
    expect(() => assertInventoryMatchesPolicy(inventory, {
      ...policy,
      allowedPlatforms: [...policy.allowedPlatforms],
      maximumInventoryBytes: 1,
    })).toThrow("byte limit");
  });
});
