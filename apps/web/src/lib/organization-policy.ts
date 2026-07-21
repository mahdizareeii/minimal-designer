export const ORGANIZATION_POLICY_SCHEMA_VERSION = 1 as const;

export const ORGANIZATION_REPOSITORY_PLATFORMS = [
  "web",
  "android",
  "ios",
  "flutter",
  "react-native",
  "generic-git",
] as const;

export const ORGANIZATION_FRAME_PRESETS = ["desktop", "phone", "tablet"] as const;
export const ORGANIZATION_ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ORGANIZATION_AGENT_ADAPTERS = ["codex", "generic_mcp"] as const;
export const ORGANIZATION_HUMAN_ROLES = [
  "organization_admin",
  "product_manager",
  "design_editor",
  "engineer",
  "viewer",
] as const;
export const ORGANIZATION_IDENTITY_CLAIMS = ["identity", "external_id", "trusted_user"] as const;
export const ORGANIZATION_TOKEN_EXPORT_FORMATS = [
  "dtcg",
  "css",
  "typescript",
  "android",
  "compose",
  "swift",
  "flutter",
] as const;

export const ORGANIZATION_AGENT_SCOPES = [
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
  "handoff:execution:plan",
  "handoff:execution:isolation",
  "handoff:execution:diff_review",
  "handoff:execution:validation",
  "handoff:execution:commit",
  "handoff:execution:push",
  "handoff:execution:pull_request",
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
] as const;

export const ORGANIZATION_POLICY_SECTION_KEYS = [
  "localization",
  "platforms",
  "designSystem",
  "assets",
  "naming",
  "accessibility",
  "agents",
  "repositories",
  "backups",
  "identity",
  "audit",
  "exports",
] as const;

export type OrganizationPolicySectionKey = (typeof ORGANIZATION_POLICY_SECTION_KEYS)[number];

export type OrganizationRepositoryPlatform = (typeof ORGANIZATION_REPOSITORY_PLATFORMS)[number];
export type OrganizationFramePreset = (typeof ORGANIZATION_FRAME_PRESETS)[number];
export type OrganizationAssetMimeType = (typeof ORGANIZATION_ASSET_MIME_TYPES)[number];
export type OrganizationAgentAdapter = (typeof ORGANIZATION_AGENT_ADAPTERS)[number];
export type OrganizationAgentScope = (typeof ORGANIZATION_AGENT_SCOPES)[number];
export type OrganizationHumanRole = (typeof ORGANIZATION_HUMAN_ROLES)[number];
export type OrganizationIdentityClaim = (typeof ORGANIZATION_IDENTITY_CLAIMS)[number];
export type OrganizationTokenExportFormat = (typeof ORGANIZATION_TOKEN_EXPORT_FORMATS)[number];

export type OrganizationPolicy = {
  schemaVersion: typeof ORGANIZATION_POLICY_SCHEMA_VERSION;
  localization: {
    defaultLocale: string;
    supportedLocales: string[];
    defaultDirection: "ltr" | "rtl" | "auto";
    rtlLocales: string[];
  };
  platforms: {
    enabled: OrganizationRepositoryPlatform[];
    framePresets: OrganizationFramePreset[];
  };
  designSystem: {
    requirePublishedRelease: boolean;
    allowDetachedTemplates: boolean;
    approvedFontFamilies: string[];
    approvedIconSets: string[];
  };
  assets: {
    enabled: boolean;
    allowedMimeTypes: OrganizationAssetMimeType[];
    maximumBytes: number;
    maximumPixels: number;
    allowAnimatedImages: false;
    allowRemoteUrls: false;
    allowSvgUpload: false;
  };
  naming: {
    projectConvention: "sentence_case" | "title_case" | "kebab_case";
    componentConvention: "pascal_case" | "sentence_case" | "kebab_case";
    tokenConvention: "dot_case" | "kebab_case";
  };
  accessibility: {
    minimumContrastRatio: number;
    minimumLargeTextContrastRatio: number;
    minimumTouchTargetPx: number;
    requireAlternativeText: boolean;
    requireFocusState: boolean;
    requireHighContrastContext: boolean;
  };
  agents: {
    enabled: boolean;
    allowLegacyEnvironmentToken: boolean;
    allowedAdapters: OrganizationAgentAdapter[];
    allowedScopes: OrganizationAgentScope[];
    maximumExpirySeconds: number;
    maximumActiveConnections: number;
    requireProjectRestriction: boolean;
  };
  repositories: {
    enabled: boolean;
    allowedPlatforms: OrganizationRepositoryPlatform[];
    requireExplicitGrant: true;
    readOnlyByDefault: true;
    maximumInventoryBytes: number;
    maximumInventoryEntities: number;
    excludedPatterns: string[];
  };
  backups: {
    enabled: boolean;
    requireVerifiedBeforeMigration: true;
    requireOffHostCopy: boolean;
    scheduleUtc: string;
    retention: {
      daily: number;
      weekly: number;
      monthly: number;
    };
  };
  identity: {
    roleMappings: Array<{
      claim: OrganizationIdentityClaim;
      value: string;
      role: OrganizationHumanRole;
    }>;
  };
  audit: {
    retentionDays: number;
    includeReadEvents: boolean;
  };
  exports: {
    allowPortableBundles: boolean;
    allowedTokenFormats: OrganizationTokenExportFormat[];
    includePreviewsByDefault: boolean;
  };
};

export function cloneOrganizationPolicy(policy: OrganizationPolicy): OrganizationPolicy {
  return structuredClone(policy);
}

export function replaceOrganizationPolicySection<K extends OrganizationPolicySectionKey>(
  policy: OrganizationPolicy,
  section: K,
  value: OrganizationPolicy[K],
): OrganizationPolicy {
  return { ...policy, [section]: value };
}

export function togglePolicyListValue<T extends string>(
  values: readonly T[],
  value: T,
  checked: boolean,
): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((entry) => entry !== value);
}

export function parsePolicyLines(value: string, splitCommas = false): string[] {
  return [...new Set(value
    .split(splitCommas ? /\r?\n|,/ : /\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

export function formatPolicyLines(values: readonly string[]): string {
  return values.join("\n");
}

export function backupScheduleToTime(scheduleUtc: string): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(scheduleUtc);
  if (!match) return "02:00";
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return "02:00";
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function timeToBackupSchedule(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "0 2 * * *";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "0 2 * * *";
  return `${minute} ${hour} * * *`;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function integerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function numberInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function validateRequiredList(
  issues: string[],
  values: readonly string[],
  label: string,
  maximum: number,
): void {
  if (values.length === 0) issues.push(`${label} must contain at least one value.`);
  if (values.length > maximum) issues.push(`${label} exceeds the ${maximum}-item limit.`);
  if (hasDuplicates(values)) issues.push(`${label} cannot contain duplicate values.`);
}

export function validateOrganizationPolicyDraft(policy: OrganizationPolicy): string[] {
  const issues: string[] = [];
  const localePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

  if (policy.schemaVersion !== ORGANIZATION_POLICY_SCHEMA_VERSION) issues.push("Policy schema version must be 1.");
  validateRequiredList(issues, policy.localization.supportedLocales, "Supported locales", 50);
  if (policy.localization.defaultLocale.length < 2 || policy.localization.defaultLocale.length > 35 || !localePattern.test(policy.localization.defaultLocale)) {
    issues.push("Default locale is not a valid 2–35 character locale identifier.");
  }
  if (!policy.localization.supportedLocales.includes(policy.localization.defaultLocale)) {
    issues.push("Default locale must also be listed as a supported locale.");
  }
  policy.localization.supportedLocales.forEach((locale) => {
    if (locale.length < 2 || locale.length > 35 || !localePattern.test(locale)) issues.push(`Supported locale “${locale}” is invalid.`);
  });
  if (policy.localization.rtlLocales.length > 50 || hasDuplicates(policy.localization.rtlLocales)) {
    issues.push("RTL locales must be unique and contain no more than 50 values.");
  }
  policy.localization.rtlLocales.forEach((locale) => {
    if (!policy.localization.supportedLocales.includes(locale)) issues.push(`RTL locale “${locale}” is not supported.`);
  });

  validateRequiredList(issues, policy.platforms.enabled, "Enabled platforms", ORGANIZATION_REPOSITORY_PLATFORMS.length);
  validateRequiredList(issues, policy.platforms.framePresets, "Frame presets", ORGANIZATION_FRAME_PRESETS.length);
  validateRequiredList(issues, policy.designSystem.approvedFontFamilies, "Approved font families", 100);
  validateRequiredList(issues, policy.designSystem.approvedIconSets, "Approved icon sets", 50);
  policy.designSystem.approvedFontFamilies.forEach((family) => {
    if (!family.trim() || family.length > 120) issues.push("Approved font family names must contain 1–120 characters.");
  });
  policy.designSystem.approvedIconSets.forEach((iconSet) => {
    if (!iconSet.trim() || iconSet.length > 120) issues.push("Approved icon-set names must contain 1–120 characters.");
  });

  validateRequiredList(issues, policy.assets.allowedMimeTypes, "Allowed image types", ORGANIZATION_ASSET_MIME_TYPES.length);
  if (!integerInRange(policy.assets.maximumBytes, 1_024, 64 * 1_024 * 1_024)) {
    issues.push("Maximum asset size must be an integer from 1 KiB through 64 MiB.");
  }
  if (!integerInRange(policy.assets.maximumPixels, 1, 100_000_000)) {
    issues.push("Maximum decoded pixels must be an integer from 1 through 100,000,000.");
  }
  if (policy.assets.allowAnimatedImages || policy.assets.allowRemoteUrls || policy.assets.allowSvgUpload) {
    issues.push("Animated images, remote URLs, and SVG uploads are fixed off in this policy version.");
  }

  if (!numberInRange(policy.accessibility.minimumContrastRatio, 1, 21)) {
    issues.push("Normal-text contrast must be between 1 and 21.");
  }
  if (!numberInRange(policy.accessibility.minimumLargeTextContrastRatio, 1, 21)) {
    issues.push("Large-text contrast must be between 1 and 21.");
  }
  if (policy.accessibility.minimumLargeTextContrastRatio > policy.accessibility.minimumContrastRatio) {
    issues.push("Large-text contrast cannot exceed the normal-text requirement.");
  }
  if (!integerInRange(policy.accessibility.minimumTouchTargetPx, 24, 96)) {
    issues.push("Minimum touch target must be an integer from 24 through 96 CSS pixels.");
  }

  validateRequiredList(issues, policy.agents.allowedAdapters, "Allowed agent adapters", ORGANIZATION_AGENT_ADAPTERS.length);
  validateRequiredList(issues, policy.agents.allowedScopes, "Allowed agent scopes", ORGANIZATION_AGENT_SCOPES.length);
  if (policy.agents.enabled && !policy.agents.allowedScopes.includes("organization_policy:read")) {
    issues.push("Enabled agents must retain the organization_policy:read scope.");
  }
  if (!integerInRange(policy.agents.maximumExpirySeconds, 300, 2_592_000)) {
    issues.push("Maximum agent lifetime must be an integer from 300 through 2,592,000 seconds.");
  }
  if (!integerInRange(policy.agents.maximumActiveConnections, 1, 100)) {
    issues.push("Maximum active agent connections must be an integer from 1 through 100.");
  }

  validateRequiredList(issues, policy.repositories.allowedPlatforms, "Repository platforms", ORGANIZATION_REPOSITORY_PLATFORMS.length);
  if (!policy.repositories.requireExplicitGrant || !policy.repositories.readOnlyByDefault) {
    issues.push("Repository access must require an explicit grant and begin read-only.");
  }
  if (!integerInRange(policy.repositories.maximumInventoryBytes, 1_024, 1_048_576)) {
    issues.push("Maximum repository inventory must be an integer from 1 KiB through 1 MiB.");
  }
  if (!integerInRange(policy.repositories.maximumInventoryEntities, 1, 10_000)) {
    issues.push("Maximum repository inventory entities must be an integer from 1 through 10,000.");
  }
  if (policy.repositories.excludedPatterns.length > 100 || hasDuplicates(policy.repositories.excludedPatterns)) {
    issues.push("Secret exclusion patterns must be unique and contain no more than 100 values.");
  }
  policy.repositories.excludedPatterns.forEach((pattern) => {
    if (!pattern.trim() || pattern.length > 240) issues.push("Secret exclusion patterns must contain 1–240 characters.");
  });

  if (!policy.backups.requireVerifiedBeforeMigration) issues.push("A verified backup is mandatory before migration.");
  const schedule = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(policy.backups.scheduleUtc);
  const scheduleMinute = Number(schedule?.[1]);
  const scheduleHour = Number(schedule?.[2]);
  if (!schedule || !Number.isInteger(scheduleMinute) || scheduleMinute < 0 || scheduleMinute > 59 || !Number.isInteger(scheduleHour) || scheduleHour < 0 || scheduleHour > 23) {
    issues.push("Backup schedule must be one valid daily UTC hour/minute expression.");
  }
  if (!integerInRange(policy.backups.retention.daily, 1, 3_650)) issues.push("Daily backup retention must be from 1 through 3,650.");
  if (!integerInRange(policy.backups.retention.weekly, 1, 520)) issues.push("Weekly backup retention must be from 1 through 520.");
  if (!integerInRange(policy.backups.retention.monthly, 1, 120)) issues.push("Monthly backup retention must be from 1 through 120.");

  if (policy.identity.roleMappings.length > 100) issues.push("Identity mappings exceed the 100-entry limit.");
  const mappedIdentities = new Set<string>();
  policy.identity.roleMappings.forEach((mapping, index) => {
    const identity = mapping.value.trim();
    if (!identity) issues.push(`Identity mapping ${index + 1} requires a claim value.`);
    else if (mappedIdentities.has(identity)) {
      issues.push(`Identity mapping ${index + 1} duplicates an existing trusted identity.`);
    } else {
      mappedIdentities.add(identity);
    }
    if (mapping.value.length > 240) issues.push(`Identity mapping ${index + 1} exceeds 240 characters.`);
  });

  if (!integerInRange(policy.audit.retentionDays, 30, 3_650)) {
    issues.push("Audit retention must be an integer from 30 through 3,650 days.");
  }
  validateRequiredList(issues, policy.exports.allowedTokenFormats, "Token export formats", ORGANIZATION_TOKEN_EXPORT_FORMATS.length);

  return [...new Set(issues)];
}

export function parseExpertOrganizationPolicyJson(value: string):
  | { ok: true; policy: Record<string, unknown> }
  | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return { ok: false, message: "Organization policy JSON is not valid." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "Organization policy must be a JSON object." };
  }
  return { ok: true, policy: parsed as Record<string, unknown> };
}
