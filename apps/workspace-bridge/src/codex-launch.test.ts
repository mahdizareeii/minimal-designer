import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeCodexLaunch,
  prepareCodexLaunch,
  sanitizedCodexEnvironment,
  type CodexProcessOptions,
} from "./codex-launch.js";
import { RepositoryGrantStore } from "./grants.js";
import { scanRepository } from "./inventory.js";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-07-20T12:00:00.000Z");
const HANDOFF_ID = `handoff_${"a".repeat(32)}`;
const INVENTORY_ID = `inventory_${"b".repeat(32)}`;
const OTHER_INVENTORY_ID = `inventory_${"c".repeat(32)}`;
const INVENTORY_HASH = "d".repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = "formaspec-workspace-launch-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function write(root: string, filename: string, contents: string): void {
  const destination = path.join(root, filename);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function executableEnvironment(extra: NodeJS.ProcessEnv = {}, executableContents = "fixture\n"): NodeJS.ProcessEnv {
  const bin = temporaryDirectory("formaspec-codex-bin-");
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, executableContents, { mode: 0o700 });
  return { PATH: bin, HOME: temporaryDirectory("formaspec-home-"), ...extra };
}

interface FixtureOptions {
  handoffStatus?: "draft" | "approved" | "implementing" | "completed";
  handoffInventoryId?: string;
  centralInventoryId?: string;
  centralInventoryHash?: string;
  centralInventoryStatus?: "active" | "superseded" | "revoked";
  approvalConfirmed?: boolean;
  repositoryFingerprint: string;
  observeAuthorization?: (value: string | null) => void;
}

function handoff(options: FixtureOptions): Record<string, unknown> {
  const status = options.handoffStatus ?? "approved";
  const transitions: Array<Record<string, unknown>> = [
    { fromStatus: null, toStatus: "draft", details: { decision: "created", version: 1 } },
    { fromStatus: "draft", toStatus: "in_review", details: { decision: "submitted", submittedVersion: 1 } },
    {
      fromStatus: "in_review",
      toStatus: "approved",
      details: {
        decision: "approved",
        approvedVersion: 1,
        acceptanceCriteriaConfirmed: options.approvalConfirmed ?? true,
        implementationPlanConfirmed: options.approvalConfirmed ?? true,
      },
    },
  ];
  if (status === "implementing") {
    transitions.push({
      fromStatus: "approved",
      toStatus: "implementing",
      details: {
        decision: "implementation_authorized",
        authorization: "start_implementation",
        approvedVersion: 1,
      },
    });
  }
  return {
    id: HANDOFF_ID,
    inventoryId: options.handoffInventoryId ?? INVENTORY_ID,
    status,
    currentVersion: 1,
    transitions,
    specification: {
      implementationPolicy: {
        preferredIsolation: "worktree",
        commitRequiresExplicitApproval: true,
        pullRequestRequiresExplicitRequest: true,
      },
    },
  };
}

function centralInventory(options: FixtureOptions): Record<string, unknown> {
  return {
    id: options.centralInventoryId ?? options.handoffInventoryId ?? INVENTORY_ID,
    repositoryFingerprint: options.repositoryFingerprint,
    inventoryHash: options.centralInventoryHash ?? INVENTORY_HASH,
    status: options.centralInventoryStatus ?? "active",
    inventory: { repositoryFingerprint: options.repositoryFingerprint },
  };
}

function policy(): Record<string, unknown> {
  return {
    policy: {
      repositories: {
        enabled: true,
        requireExplicitGrant: true,
        readOnlyByDefault: true,
        excludedPatterns: [],
        allowedPlatforms: ["web", "generic-git"],
        maximumInventoryBytes: 1_048_576,
        maximumInventoryEntities: 10_000,
      },
    },
  };
}

function mcpFetch(options: FixtureOptions): typeof fetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      params?: { name?: unknown };
    };
    const name = request.params?.name;
    const structuredContent = name === "organization_policy_read"
      ? { ok: true, organizationPolicy: policy() }
      : name === "handoff_read"
        ? { ok: true, handoff: handoff(options) }
        : name === "repository_inventory_read"
          ? { ok: true, inventory: centralInventory(options) }
          : { ok: false };
    return Response.json({ jsonrpc: "2.0", id: "fixture", result: { structuredContent } });
  }) as typeof fetch;
}

function apiFetch(options: FixtureOptions): typeof fetch {
  return (async (input, init) => {
    options.observeAuthorization?.(new Headers(init?.headers).get("authorization"));
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/organization/policy") return Response.json({ organizationPolicy: policy() });
    if (url.pathname === `/api/handoffs/${HANDOFF_ID}`) return Response.json({ handoff: handoff(options) });
    if (url.pathname.startsWith("/api/repository-inventories/")) {
      return Response.json({ inventory: centralInventory(options) });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
}

async function authorizedFixture(): Promise<{
  root: string;
  store: RepositoryGrantStore;
  grantId: string;
  repositoryFingerprint: string;
}> {
  const root = temporaryDirectory();
  write(root, "package.json", JSON.stringify({ dependencies: {} }));
  write(root, "src/App.tsx", "export function App() { return null; }\n");
  write(root, "assets/logo.png", "asset-one");
  const inventory = await scanRepository(root, { now: NOW });
  const store = new RepositoryGrantStore(temporaryDirectory("formaspec-grants-"));
  const grant = await store.create(root, inventory.repositoryFingerprint, { now: NOW, ttlSeconds: 3_600 });
  await store.bindPersistedInventory(grant.id, { id: INVENTORY_ID, inventoryHash: INVENTORY_HASH }, NOW);
  return { root: await fs.promises.realpath(root), store, grantId: grant.id, repositoryFingerprint: inventory.repositoryFingerprint };
}

describe("approved selected-workspace Codex launch", () => {
  it("revalidates the exact grant and launches Codex with one secret-free argument in the selected cwd", async () => {
    const fixture = await authorizedFixture();
    const secret = "central-secret-token-value";
    const environment = executableEnvironment({
      FORMASPEC_API_TOKEN: secret,
      DESIGNER_TOKEN: "legacy-central-secret",
      OPENAI_API_KEY: "openai-secret",
      GITHUB_TOKEN: "github-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      INTERNAL_CREDENTIAL: "generic-secret",
      LC_SECRET: "locale-shaped-secret",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
    });
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment,
      fetchImplementation: mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint }),
      now: () => NOW,
    };
    const prepared = await prepareCodexLaunch(options);
    let invocation: { executable: string; arguments_: readonly string[]; options: CodexProcessOptions } | null = null;
    const launched = await executeCodexLaunch(prepared, {
      ...options,
      processLauncher: async (executable, arguments_, processOptions) => {
        invocation = { executable, arguments_, options: processOptions };
        return 0;
      },
    });

    expect(launched.exitCode).toBe(0);
    expect(invocation).not.toBeNull();
    expect(invocation!.executable).toBe(prepared.executable);
    expect(invocation!.arguments_).toEqual(prepared.arguments);
    expect(invocation!.arguments_).toHaveLength(1);
    expect(invocation!.arguments_[0]).toContain(`Use Minimal UI`);
    expect(invocation!.arguments_[0]).toContain(`formaspec://handoffs/${HANDOFF_ID}`);
    expect(invocation!.arguments_[0]).not.toContain(fixture.root);
    expect(invocation!.options.cwd).toBe(fixture.root);
    expect(invocation!.options.env.FORMASPEC_API_TOKEN).toBeUndefined();
    expect(invocation!.options.env.DESIGNER_TOKEN).toBeUndefined();
    expect(invocation!.options.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation!.options.env.GITHUB_TOKEN).toBeUndefined();
    expect(invocation!.options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(invocation!.options.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(invocation!.options.env.INTERNAL_CREDENTIAL).toBeUndefined();
    expect(invocation!.options.env.LC_SECRET).toBeUndefined();
    expect(invocation!.options.env.LC_ALL).toBe("en_US.UTF-8");
    expect(invocation!.options.env.TERM).toBe("xterm-256color");
    expect(JSON.stringify(prepared)).not.toContain(secret);
  });

  it("canonicalizes Windows environment casing without admitting credential-shaped variables", () => {
    expect(sanitizedCodexEnvironment({
      Path: "C:\\Windows\\System32",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      SystemRoot: "C:\\Windows",
      UserProfile: "C:\\Users\\FormaSpec",
      Github_Token: "must-not-pass",
    }, "win32")).toEqual({
      PATH: "C:\\Windows\\System32",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\FormaSpec",
    });
  });

  it("accepts only approved or explicitly implementing handoffs with intact approval metadata", async () => {
    const fixture = await authorizedFixture();
    const base = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      now: () => NOW,
    };
    await expect(prepareCodexLaunch({
      ...base,
      fetchImplementation: mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint, handoffStatus: "draft" }),
    })).rejects.toThrow("not an approved implementation handoff");
    await expect(prepareCodexLaunch({
      ...base,
      fetchImplementation: mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint, approvalConfirmed: false }),
    })).rejects.toThrow("approval metadata");
    await expect(prepareCodexLaunch({
      ...base,
      fetchImplementation: mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint, handoffStatus: "implementing" }),
    })).resolves.toMatchObject({ handoffStatus: "implementing" });
  });

  it("rejects any reviewed-plan status, version, schema, or argument substitution", async () => {
    const fixture = await authorizedFixture();
    const centralState: FixtureOptions = { repositoryFingerprint: fixture.repositoryFingerprint };
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch(centralState),
      now: () => NOW,
    };
    const plan = await prepareCodexLaunch(options);
    const substituted = {
      ...plan,
      handoffStatus: "implementing",
      handoffVersion: 2,
      schemaVersion: 2,
      arguments: ["substituted prompt"],
    } as unknown as typeof plan;
    await expect(executeCodexLaunch(substituted, {
      ...options,
      processLauncher: async () => 0,
    })).rejects.toThrow("launch context changed after review");

    centralState.handoffStatus = "implementing";
    await expect(executeCodexLaunch(plan, {
      ...options,
      processLauncher: async () => 0,
    })).rejects.toThrow("launch context changed after review");
  });

  it("fails closed when the handoff or central inventory differs from the local grant binding", async () => {
    const fixture = await authorizedFixture();
    const base = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      now: () => NOW,
    };
    await expect(prepareCodexLaunch({
      ...base,
      fetchImplementation: mcpFetch({
        repositoryFingerprint: fixture.repositoryFingerprint,
        handoffInventoryId: OTHER_INVENTORY_ID,
      }),
    })).rejects.toThrow("different repository inventory");
    await expect(prepareCodexLaunch({
      ...base,
      fetchImplementation: mcpFetch({
        repositoryFingerprint: fixture.repositoryFingerprint,
        centralInventoryHash: "e".repeat(64),
      }),
    })).rejects.toThrow("does not match");
  });

  it("honors local grant and central inventory revocation and detects repository changes", async () => {
    const revokedFixture = await authorizedFixture();
    await revokedFixture.store.revoke(revokedFixture.grantId, new Date(NOW.getTime() + 1_000));
    await expect(prepareCodexLaunch({
      grantStore: revokedFixture.store,
      grantId: revokedFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: revokedFixture.repositoryFingerprint }),
      now: () => new Date(NOW.getTime() + 2_000),
    })).rejects.toThrow("revoked");

    const centralRevokedFixture = await authorizedFixture();
    await expect(prepareCodexLaunch({
      grantStore: centralRevokedFixture.store,
      grantId: centralRevokedFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({
        repositoryFingerprint: centralRevokedFixture.repositoryFingerprint,
        centralInventoryStatus: "revoked",
      }),
      now: () => NOW,
    })).rejects.toThrow("launch is revoked");

    const changedFixture = await authorizedFixture();
    write(changedFixture.root, "src/Changed.ts", "export const Changed = true;\n");
    await expect(prepareCodexLaunch({
      grantStore: changedFixture.store,
      grantId: changedFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: changedFixture.repositoryFingerprint }),
      now: () => NOW,
    })).rejects.toThrow("Repository contents changed");

    const revalidationFixture = await authorizedFixture();
    const revalidationOptions = {
      grantStore: revalidationFixture.store,
      grantId: revalidationFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: revalidationFixture.repositoryFingerprint }),
      now: () => NOW,
    };
    const reviewedPlan = await prepareCodexLaunch(revalidationOptions);
    await revalidationFixture.store.revoke(
      revalidationFixture.grantId,
      new Date(NOW.getTime() + 1_000),
    );
    let launched = false;
    await expect(executeCodexLaunch(reviewedPlan, {
      ...revalidationOptions,
      now: () => new Date(NOW.getTime() + 2_000),
      processLauncher: async () => {
        launched = true;
        return 0;
      },
    })).rejects.toThrow("revoked");
    expect(launched).toBe(false);

    const duringSpawnFixture = await authorizedFixture();
    const duringSpawnOptions = {
      grantStore: duringSpawnFixture.store,
      grantId: duringSpawnFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: duringSpawnFixture.repositoryFingerprint }),
      now: () => NOW,
    };
    const duringSpawnPlan = await prepareCodexLaunch(duringSpawnOptions);
    await expect(executeCodexLaunch(duringSpawnPlan, {
      ...duringSpawnOptions,
      processLauncher: async (_executable, _arguments, processOptions) => {
        await duringSpawnFixture.store.revoke(
          duringSpawnFixture.grantId,
          new Date(NOW.getTime() + 1_000),
        );
        await processOptions.preSpawnAuthorizationProbe();
        return 0;
      },
    })).rejects.toThrow("revoked");

    const fingerprintDriftFixture = await authorizedFixture();
    const fingerprintDriftOptions = {
      grantStore: fingerprintDriftFixture.store,
      grantId: fingerprintDriftFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: fingerprintDriftFixture.repositoryFingerprint }),
      now: () => NOW,
    };
    const fingerprintDriftPlan = await prepareCodexLaunch(fingerprintDriftOptions);
    await expect(executeCodexLaunch(fingerprintDriftPlan, {
      ...fingerprintDriftOptions,
      processLauncher: async (_executable, _arguments, processOptions) => {
        write(fingerprintDriftFixture.root, "assets/logo.png", "asset-two");
        await processOptions.preSpawnAuthorizationProbe();
        return 0;
      },
    })).rejects.toThrow("Repository contents changed after launch review");
  });

  it("terminates a spawned Codex process when the ongoing authorization probe is revoked", async () => {
    if (process.platform === "win32") return;
    const fixture = await authorizedFixture();
    const processState = temporaryDirectory("formaspec-process-tree-");
    const grandchildPidPath = path.join(processState, "grandchild.pid");
    const grandchildCode = "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);";
    const codexFixture = `#!${process.execPath}\n`
      + `const { spawn } = require('node:child_process');\n`
      + `const fs = require('node:fs');\n`
      + `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });\n`
      + `fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));\n`
      + `setInterval(() => undefined, 1000);\n`;
    const environment = executableEnvironment({}, codexFixture);
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment,
      fetchImplementation: mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint }),
      now: () => NOW,
    };
    const plan = await prepareCodexLaunch(options);
    const revokeWhenRunning = (async () => {
      for (let attempt = 0; attempt < 100 && !fs.existsSync(grandchildPidPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await fixture.store.revoke(fixture.grantId, new Date(NOW.getTime() + 1_000));
    })();
    await expect(executeCodexLaunch(plan, options)).resolves.toMatchObject({ exitCode: 128 });
    await revokeWhenRunning;
    const grandchildPid = Number(fs.readFileSync(grandchildPidPath, "utf8"));
    expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);
    expect(await waitForProcessExit(grandchildPid)).toBe(true);
  });

  it("makes central revocation and local expiry observable to the running-process authorization monitor", async () => {
    const fixture = await authorizedFixture();
    const centralState: FixtureOptions = { repositoryFingerprint: fixture.repositoryFingerprint };
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch(centralState),
      now: () => NOW,
    };
    const plan = await prepareCodexLaunch(options);
    await expect(executeCodexLaunch(plan, {
      ...options,
      processLauncher: async (_executable, _arguments, processOptions) => {
        centralState.centralInventoryStatus = "revoked";
        await processOptions.authorizationProbe();
        return 0;
      },
    })).rejects.toThrow("revoked or changed");

    const expiryFixture = await authorizedFixture();
    let clock = NOW;
    const expiryOptions = {
      grantStore: expiryFixture.store,
      grantId: expiryFixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: expiryFixture.repositoryFingerprint }),
      now: () => clock,
    };
    const expiryPlan = await prepareCodexLaunch(expiryOptions);
    await expect(executeCodexLaunch(expiryPlan, {
      ...expiryOptions,
      processLauncher: async (_executable, _arguments, processOptions) => {
        clock = new Date(NOW.getTime() + 3_601_000);
        await processOptions.authorizationProbe();
        return 0;
      },
    })).rejects.toThrow("expired");
  });

  it("fails a stalled ongoing authorization probe closed on its hard deadline", async () => {
    const fixture = await authorizedFixture();
    let stallPolicyBody = false;
    const normalFetch = mcpFetch({ repositoryFingerprint: fixture.repositoryFingerprint });
    const fetchImplementation = (async (input, init) => {
      if (!stallPolicyBody) return normalFetch(input, init);
      const request = JSON.parse(String(init?.body)) as { params?: { name?: unknown } };
      if (request.params?.name !== "organization_policy_read") return normalFetch(input, init);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation,
      now: () => NOW,
    };
    const plan = await prepareCodexLaunch(options);
    await expect(executeCodexLaunch(plan, {
      ...options,
      processLauncher: async (_executable, _arguments, processOptions) => {
        stallPolicyBody = true;
        vi.useFakeTimers();
        try {
          const probe = processOptions.authorizationProbe();
          const settledProbe = probe.then(
            () => null,
            (error: unknown) => error,
          );
          await vi.advanceTimersByTimeAsync(5_001);
          const error = await settledProbe;
          if (!(error instanceof Error)) throw new Error("Stalled authorization probe unexpectedly succeeded.");
          throw error;
        } finally {
          vi.useRealTimers();
        }
      },
    })).rejects.toThrow("timed out and authorization failed closed");
  });

  it("uses the narrow REST alternative for validation without leaking its bearer token into Codex", async () => {
    const fixture = await authorizedFixture();
    const token = "rest-boundary-secret";
    const observedAuthorization: Array<string | null> = [];
    const environment = executableEnvironment({ FORMASPEC_API_TOKEN: token });
    const options = {
      grantStore: fixture.store,
      grantId: fixture.grantId,
      handoffId: HANDOFF_ID,
      connection: { apiUrl: "https://formaspec.example.test", bearerToken: token },
      environment,
      fetchImplementation: apiFetch({
        repositoryFingerprint: fixture.repositoryFingerprint,
        observeAuthorization: (value) => observedAuthorization.push(value),
      }),
      now: () => NOW,
    };
    const plan = await prepareCodexLaunch(options);
    let childEnvironment: NodeJS.ProcessEnv = {};
    await executeCodexLaunch(plan, {
      ...options,
      processLauncher: async (_executable, _arguments, processOptions) => {
        childEnvironment = processOptions.env;
        return 0;
      },
    });
    expect(observedAuthorization).toContain(`Bearer ${token}`);
    expect(childEnvironment.FORMASPEC_API_TOKEN).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain(token);
  });

  it("requires a connected grant with an immutable persisted-inventory binding", async () => {
    const root = temporaryDirectory();
    write(root, "README.md", "unbound grant\n");
    const inventory = await scanRepository(root, { now: NOW });
    const store = new RepositoryGrantStore(temporaryDirectory("formaspec-unbound-grants-"));
    const grant = await store.create(root, inventory.repositoryFingerprint, { now: NOW, ttlSeconds: 3_600 });
    await expect(prepareCodexLaunch({
      grantStore: store,
      grantId: grant.id,
      handoffId: HANDOFF_ID,
      connection: { mcpUrl: "http://127.0.0.1:4312/mcp" },
      environment: executableEnvironment(),
      fetchImplementation: mcpFetch({ repositoryFingerprint: inventory.repositoryFingerprint }),
      now: () => NOW,
    })).rejects.toThrow("not bound to a persisted");
    await store.bindPersistedInventory(grant.id, { id: INVENTORY_ID, inventoryHash: INVENTORY_HASH }, NOW);
    await expect(store.bindPersistedInventory(grant.id, {
      id: OTHER_INVENTORY_ID,
      inventoryHash: INVENTORY_HASH,
    }, NOW)).rejects.toThrow("different persisted inventory");
  });
});
