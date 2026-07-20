import { EventEmitter } from "node:events";

import type { FastifyReply } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { EnterpriseService } from "./enterprise-service.js";
import { EventHub } from "./events.js";
import { sendSse } from "./http-routes.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";
import { DesignerService } from "./service.js";
import { WorkspaceHandoffService, type UploadRepositoryInventory } from "./workspace-handoff-service.js";

const opened: DesignerDatabase[] = [];

function setup() {
  const database = new DesignerDatabase(":memory:");
  opened.push(database);
  const events = new EventHub();
  return {
    database,
    events,
    designer: new DesignerService(database, events, 900),
    enterprise: new EnterpriseService(database, events),
    policies: new OrganizationPolicyService(database, { now: () => new Date("2026-07-20T12:00:00.000Z") }),
    handoffs: new WorkspaceHandoffService(database),
  };
}

function mutableDefaultPolicy(): typeof DEFAULT_ORGANIZATION_POLICY {
  return structuredClone(DEFAULT_ORGANIZATION_POLICY);
}

function inventory(overrides: Partial<UploadRepositoryInventory> = {}): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: "2026-07-20T11:00:00.000Z",
    platforms: ["web"],
    gitHead: "b".repeat(40),
    scannedFileCount: 1,
    skippedFileCount: 0,
    bytesRead: 100,
    truncated: false,
    excludedPatterns: [...DEFAULT_ORGANIZATION_POLICY.repositories.excludedPatterns],
    entities: [{
      id: `inv_${"1".repeat(40)}`,
      kind: "component",
      name: "Button",
      symbol: "Button",
      locationId: `loc_${"2".repeat(40)}`,
      line: 1,
    }],
    excluded: [],
    ...overrides,
  };
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("organization policy", () => {
  it("loads backward-compatible defaults and emits deterministic secret-free YAML", () => {
    const opened = setup();
    const first = opened.policies.read("local");
    const second = opened.policies.read("local");

    expect(first.source).toBe("default");
    expect(first.policy.schemaVersion).toBe(1);
    expect(first.policy.localization.rtlLocales).toContain("fa-IR");
    expect(first.policy.agents.allowedScopes).toContain("organization_policy:read");
    expect(first).toEqual(second);

    const exported = opened.policies.exportYaml("local");
    expect(exported.filename).toBe("organization.formaspec.yaml");
    expect(exported.yaml).toContain('format: "formaspec-organization-config"');
    expect(exported.yaml).toContain(`policy_hash: "${first.policyHash}"`);
    expect(exported.yaml).not.toMatch(/bearer|password|token_hash|grantToken|repositoryPath/i);
    expect(opened.policies.exportYaml("local")).toEqual(exported);
  });

  it("updates with optimistic concurrency and records only bounded policy hashes", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.agents.maximumActiveConnections = 3;
    policy.repositories.allowedPlatforms = ["web", "android"];
    policy.backups.enabled = false;
    policy.backups.scheduleUtc = "15 3 * * *";
    policy.backups.retention = { daily: 3, weekly: 2, monthly: 6 };

    const updated = opened.policies.update("local", {
      expectedConfigurationHash: current.configurationHash,
      policy,
    });
    expect(updated.source).toBe("stored");
    expect(updated.previousConfigurationHash).toBe(current.configurationHash);
    expect(updated.policy.agents.maximumActiveConnections).toBe(3);
    expect(updated.configurationHash).toBe(updated.policyHash);
    expect(opened.database.sqlite.prepare(
      `SELECT enabled, cron_expression, daily_retention, weekly_retention, monthly_retention
       FROM backup_schedules WHERE organization_id = 'organization_legacy'`,
    ).get()).toEqual({
      enabled: 0,
      cron_expression: "15 3 * * *",
      daily_retention: 3,
      weekly_retention: 2,
      monthly_retention: 6,
    });

    const audit = opened.database.sqlite.prepare(
      "SELECT action, details_json FROM audit_events WHERE action = 'organization_policy.update'",
    ).get() as { action: string; details_json: string };
    expect(audit.action).toBe("organization_policy.update");
    expect(JSON.parse(audit.details_json)).toEqual({
      previousConfigurationHash: current.configurationHash,
      policyHash: updated.policyHash,
      schemaVersion: 1,
    });
    expect(captureThrown(() => opened.policies.update("local", {
      expectedConfigurationHash: current.configurationHash,
      policy,
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
  });

  it("rejects out-of-range daily backup times", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.backups.scheduleUtc = "99 99 * * *";
    expect(captureThrown(() => opened.policies.update("local", {
      expectedConfigurationHash: current.configurationHash,
      policy,
    }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
  });

  it("preserves unknown legacy configuration as non-exported quarantine until an explicit save", () => {
    const opened = setup();
    opened.database.sqlite.prepare(
      "UPDATE organizations SET config_json = ? WHERE id = 'organization_legacy'",
    ).run(JSON.stringify({ obsoleteSetting: true, possibleSecret: "do-not-export" }));

    const loaded = opened.policies.read("local");
    expect(loaded.source).toBe("legacy_quarantined");
    expect(loaded.diagnostics).toEqual([expect.objectContaining({ code: "LEGACY_ORGANIZATION_CONFIG_QUARANTINED" })]);
    const exported = opened.policies.exportYaml("local");
    expect(exported.yaml).not.toContain("obsoleteSetting");
    expect(exported.yaml).not.toContain("do-not-export");
  });

  it("fails closed after a governed policy is corrupted instead of restoring permissive defaults", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.agents.enabled = false;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });
    opened.database.sqlite.prepare(
      "UPDATE organizations SET config_json = '{malformed' WHERE id = 'organization_legacy'",
    ).run();

    const loaded = opened.policies.read("local");
    expect(loaded.source).toBe("corrupt_fail_closed");
    expect(loaded.policy.agents.enabled).toBe(false);
    expect(loaded.policy.repositories.enabled).toBe(false);
    expect(loaded.policy.assets.enabled).toBe(false);
    expect(loaded.policy.backups.enabled).toBe(false);
    expect(loaded.diagnostics).toEqual([expect.objectContaining({
      code: "ORGANIZATION_POLICY_CORRUPT_FAIL_CLOSED",
      severity: "error",
    })]);
    expect(captureThrown(() => resolveAccess(opened.database.sqlite, "usr_legacy_environment_token"))).toMatchObject({
      code: "AUTH_REQUIRED",
      statusCode: 401,
    });
  });

  it("applies trusted identity role mappings and policy-bounds the legacy environment token", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.identity.roleMappings = [{ claim: "identity", value: "alice@example.com", role: "viewer" }];
    policy.agents.allowedScopes = ["organization_policy:read", "design:read"];
    policy.agents.maximumExpirySeconds = 3_600;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    expect(resolveAccess(opened.database.sqlite, "trusted:alice@example.com").role).toBe("viewer");
    const legacy = resolveAccess(opened.database.sqlite, "usr_environment_token");
    expect(legacy.role).toBe("agent");
    expect(legacy.scopes).toEqual(["organization_policy:read", "design:read"]);
    opened.database.sqlite.prepare(
      "UPDATE principals SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(legacy.principalId);
    expect(captureThrown(() => resolveAccess(opened.database.sqlite, "usr_environment_token"))).toMatchObject({
      code: "AUTH_REQUIRED",
      statusCode: 401,
    });
  });

  it("terminates an already-open agent event stream when policy revokes the grant", () => {
    const opened = setup();
    const design = opened.designer.createDesign("local", {
      name: "SSE policy",
      preset: "web",
      idempotencyKey: "organization-policy-sse-design-0001",
    });
    const challenge = opened.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "SSE policy agent",
      scopes: ["organization_policy:read", "design:read"],
      projectIds: [design.document.id],
      expiresInSeconds: 3_600,
    });
    const paired = opened.enterprise.pairAgentConnection(challenge.nonce);
    class FakeRawReply extends EventEmitter {
      ended = false;
      writeHead(): void {}
      write(): boolean { return true; }
      end(): void { this.ended = true; this.emit("close"); }
    }
    const raw = new FakeRawReply();
    const reply = { hijack() {}, raw } as unknown as FastifyReply;
    sendSse(reply, opened.events, opened.designer, paired.grant.actorId, undefined);
    expect(raw.ended).toBe(false);

    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.agents.enabled = false;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });
    opened.events.publishWorkspace("local", "design.updated", { designId: design.document.id, version: 2 });
    expect(raw.ended).toBe(true);
  });

  it("enforces policy for new, paired, and already-issued agent grants", () => {
    const opened = setup();
    const challenge = opened.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Policy test Codex",
      scopes: ["organization_policy:read", "design:read"],
      expiresInSeconds: 3_600,
    });
    const paired = opened.enterprise.pairAgentConnection(challenge.nonce);
    expect(resolveAccess(opened.database.sqlite, paired.grant.actorId).role).toBe("agent");

    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.agents.allowedScopes = ["organization_policy:read"];
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    expect(captureThrown(() => resolveAccess(opened.database.sqlite, paired.grant.actorId))).toMatchObject({
      code: "AUTH_REQUIRED",
      statusCode: 401,
    });
    expect(captureThrown(() => opened.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Disallowed scope",
      scopes: ["design:read"],
      expiresInSeconds: 3_600,
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("applies repository platform, byte, entity, and enablement limits before persistence", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = mutableDefaultPolicy();
    policy.repositories.allowedPlatforms = ["android"];
    policy.repositories.maximumInventoryBytes = 1_024;
    policy.repositories.maximumInventoryEntities = 1;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", inventory()))).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });

    const stored = opened.policies.read("local");
    const disabled = mutableDefaultPolicy();
    disabled.repositories.enabled = false;
    opened.policies.update("local", { expectedConfigurationHash: stored.configurationHash, policy: disabled });
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", inventory({ platforms: ["android"] })))).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });
});
