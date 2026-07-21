import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrganizationPolicyEditor } from "../components/OrganizationPolicyEditor";
import {
  updateOrganizationPolicy,
  type OrganizationPolicyRecord,
} from "../lib/api";
import {
  ORGANIZATION_AGENT_SCOPES,
  ORGANIZATION_POLICY_SECTION_KEYS,
  backupScheduleToTime,
  cloneOrganizationPolicy,
  parseExpertOrganizationPolicyJson,
  parsePolicyLines,
  replaceOrganizationPolicySection,
  timeToBackupSchedule,
  togglePolicyListValue,
  validateOrganizationPolicyDraft,
  type OrganizationPolicy,
} from "../lib/organization-policy";

const CONFIGURATION_HASH = "b".repeat(64);

function createPolicy(): OrganizationPolicy {
  return {
    schemaVersion: 1,
    localization: {
      defaultLocale: "en-US",
      supportedLocales: ["en-US", "fa-IR"],
      defaultDirection: "auto",
      rtlLocales: ["fa-IR"],
    },
    platforms: {
      enabled: ["web", "android", "ios", "flutter", "react-native", "generic-git"],
      framePresets: ["desktop", "phone", "tablet"],
    },
    designSystem: {
      requirePublishedRelease: false,
      allowDetachedTemplates: true,
      approvedFontFamilies: ["Inter", "Vazirmatn"],
      approvedIconSets: ["Lucide"],
    },
    assets: {
      enabled: true,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maximumBytes: 16 * 1_048_576,
      maximumPixels: 40_000_000,
      allowAnimatedImages: false,
      allowRemoteUrls: false,
      allowSvgUpload: false,
    },
    naming: {
      projectConvention: "sentence_case",
      componentConvention: "pascal_case",
      tokenConvention: "dot_case",
    },
    accessibility: {
      minimumContrastRatio: 4.5,
      minimumLargeTextContrastRatio: 3,
      minimumTouchTargetPx: 44,
      requireAlternativeText: true,
      requireFocusState: true,
      requireHighContrastContext: true,
    },
    agents: {
      enabled: true,
      allowLegacyEnvironmentToken: true,
      allowedAdapters: ["codex", "generic_mcp"],
      allowedScopes: [...ORGANIZATION_AGENT_SCOPES],
      maximumExpirySeconds: 2_592_000,
      maximumActiveConnections: 10,
      requireProjectRestriction: false,
    },
    repositories: {
      enabled: true,
      allowedPlatforms: ["web", "android", "ios", "flutter", "react-native", "generic-git"],
      requireExplicitGrant: true,
      readOnlyByDefault: true,
      maximumInventoryBytes: 1_048_576,
      maximumInventoryEntities: 10_000,
      excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    },
    backups: {
      enabled: true,
      requireVerifiedBeforeMigration: true,
      requireOffHostCopy: false,
      scheduleUtc: "0 2 * * *",
      retention: { daily: 7, weekly: 4, monthly: 12 },
    },
    identity: { roleMappings: [] },
    audit: { retentionDays: 365, includeReadEvents: false },
    exports: {
      allowPortableBundles: true,
      allowedTokenFormats: ["dtcg", "css", "typescript", "android", "compose", "swift", "flutter"],
      includePreviewsByDefault: true,
    },
  };
}

function createRecord(policy = createPolicy()): OrganizationPolicyRecord {
  return {
    organizationId: "organization_legacy",
    organizationName: "FormaSpec workspace",
    policy,
    policyHash: "a".repeat(64),
    configurationHash: CONFIGURATION_HASH,
    source: "stored",
    diagnostics: [],
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function editEveryPolicySection(policy: OrganizationPolicy): OrganizationPolicy {
  let draft = cloneOrganizationPolicy(policy);
  draft = replaceOrganizationPolicySection(draft, "localization", { ...draft.localization, defaultLocale: "fa-IR" });
  draft = replaceOrganizationPolicySection(draft, "platforms", { ...draft.platforms, enabled: ["web", "ios"] });
  draft = replaceOrganizationPolicySection(draft, "designSystem", { ...draft.designSystem, requirePublishedRelease: true });
  draft = replaceOrganizationPolicySection(draft, "assets", { ...draft.assets, maximumBytes: 8 * 1_048_576 });
  draft = replaceOrganizationPolicySection(draft, "naming", { ...draft.naming, projectConvention: "title_case" });
  draft = replaceOrganizationPolicySection(draft, "accessibility", { ...draft.accessibility, minimumContrastRatio: 7 });
  draft = replaceOrganizationPolicySection(draft, "agents", {
    ...draft.agents,
    maximumActiveConnections: 8,
    allowedScopes: togglePolicyListValue(draft.agents.allowedScopes, "redesign:implement", false),
  });
  draft = replaceOrganizationPolicySection(draft, "repositories", { ...draft.repositories, maximumInventoryEntities: 5_000 });
  draft = replaceOrganizationPolicySection(draft, "backups", { ...draft.backups, retention: { ...draft.backups.retention, daily: 14 } });
  draft = replaceOrganizationPolicySection(draft, "identity", {
    roleMappings: [{ claim: "identity", value: "admin@example.test", role: "organization_admin" }],
  });
  draft = replaceOrganizationPolicySection(draft, "audit", { ...draft.audit, retentionDays: 730 });
  draft = replaceOrganizationPolicySection(draft, "exports", { ...draft.exports, includePreviewsByDefault: false });
  return draft;
}

afterEach(() => vi.restoreAllMocks());

describe("form-based organization policy administration", () => {
  it("renders all 12 guided sections, accessible groups, YAML export, Expert JSON, and optimistic lock metadata", () => {
    const html = renderToStaticMarkup(<OrganizationPolicyEditor
      record={createRecord()}
      loading={false}
      disabled={false}
      saving={false}
      onSave={async () => undefined}
      onError={() => undefined}
    />);

    for (const title of [
      "Localization",
      "Platforms",
      "Design-system policy",
      "Assets",
      "Naming",
      "Accessibility",
      "Agents and scopes",
      "Repositories",
      "Backups and retention",
      "Identity mappings",
      "Audit",
      "Exports",
    ]) expect(html).toContain(`>${title}<`);

    expect(html).toContain("Guided settings");
    expect(html).toContain("Expert JSON");
    expect(html).toContain('href="/api/organization/configuration"');
    expect(html).toContain("Export YAML");
    expect(html).toContain(`Configuration lock: <code>${CONFIGURATION_HASH}</code>`);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend>Allowed adapters</legend>");
    expect(html).toContain('min="300"');
    expect(html).toContain('max="2592000"');
    expect(html).toContain("No passwords, bearer grants, Keychain values");
  });

  it("immutably edits every policy section and saves the full policy with the original configuration hash", async () => {
    const original = createPolicy();
    const edited = editEveryPolicySection(original);
    expect(validateOrganizationPolicyDraft(edited)).toEqual([]);
    for (const section of ORGANIZATION_POLICY_SECTION_KEYS) {
      expect(edited[section]).not.toEqual(original[section]);
    }
    expect(original.agents.maximumActiveConnections).toBe(10);
    expect(original.agents.allowedScopes).toContain("redesign:implement");
    expect(edited.agents.allowedScopes).not.toContain("redesign:implement");

    const response = createRecord(edited);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      organizationPolicy: { ...response, configurationHash: "c".repeat(64) },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await updateOrganizationPolicy(CONFIGURATION_HASH, edited);
    const request = fetch.mock.calls[0];
    expect(request?.[0]).toBe("/api/organization/policy");
    expect(request?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      expectedConfigurationHash: CONFIGURATION_HASH,
      policy: edited,
    });
  });

  it("keeps server-valid cron spellings, string bounds, and the deliberate Expert JSON escape hatch", () => {
    const policy = createPolicy();
    policy.backups.scheduleUtc = "00 02 * * *";
    expect(validateOrganizationPolicyDraft(policy)).toEqual([]);
    expect(backupScheduleToTime(policy.backups.scheduleUtc)).toBe("02:00");
    expect(timeToBackupSchedule("23:45")).toBe("45 23 * * *");
    expect(parsePolicyLines("**/*.{pem,key}\n.env")).toEqual(["**/*.{pem,key}", ".env"]);
    expect(parsePolicyLines("en-US, fa-IR", true)).toEqual(["en-US", "fa-IR"]);

    const tooLong = cloneOrganizationPolicy(policy);
    tooLong.designSystem.approvedFontFamilies = ["x".repeat(121)];
    tooLong.repositories.excludedPatterns = ["x".repeat(241)];
    expect(validateOrganizationPolicyDraft(tooLong)).toEqual(expect.arrayContaining([
      "Approved font family names must contain 1–120 characters.",
      "Secret exclusion patterns must contain 1–240 characters.",
    ]));

    expect(parseExpertOrganizationPolicyJson(JSON.stringify(policy))).toEqual({ ok: true, policy });
    expect(parseExpertOrganizationPolicyJson("[]")).toEqual({ ok: false, message: "Organization policy must be a JSON object." });
    expect(parseExpertOrganizationPolicyJson("{")).toEqual({ ok: false, message: "Organization policy JSON is not valid." });
  });

  it("rejects duplicate trusted identities across claim aliases before save", () => {
    const policy = createPolicy();
    policy.identity.roleMappings = [
      { claim: "identity", value: " alice@example.test ", role: "viewer" },
      { claim: "external_id", value: "alice@example.test", role: "organization_admin" },
    ];

    expect(validateOrganizationPolicyDraft(policy)).toContain(
      "Identity mapping 2 duplicates an existing trusted identity.",
    );

    policy.identity.roleMappings[1] = {
      claim: "external_id",
      value: "bob@example.test",
      role: "organization_admin",
    };
    expect(validateOrganizationPolicyDraft(policy)).toEqual([]);
  });
});
