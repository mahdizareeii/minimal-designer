import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

export const ORGANIZATION_POLICY_SCHEMA_VERSION = 1 as const;
export const ORGANIZATION_POLICY_MAX_BYTES = 256 * 1_024;

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
] as const;

export const ORGANIZATION_REPOSITORY_PLATFORMS = [
  "web",
  "android",
  "ios",
  "flutter",
  "react-native",
  "generic-git",
] as const;

const localeSchema = z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const uniqueStrings = <T extends z.ZodTypeAny>(item: T, maximum: number, minimum = 0) => z.array(item).min(minimum).max(maximum).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((itemValue, index) => {
    const key = String(itemValue);
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "Entries must be unique." });
    }
    seen.add(key);
  });
});

const humanRoleSchema = z.enum([
  "organization_admin",
  "product_manager",
  "design_editor",
  "engineer",
  "viewer",
]);

const localizationPolicySchema = z.object({
  defaultLocale: localeSchema,
  supportedLocales: uniqueStrings(localeSchema, 50, 1),
  defaultDirection: z.enum(["ltr", "rtl", "auto"]),
  rtlLocales: uniqueStrings(localeSchema, 50),
}).strict().superRefine((value, context) => {
  if (!value.supportedLocales.includes(value.defaultLocale)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["defaultLocale"], message: "The default locale must be supported." });
  }
  value.rtlLocales.forEach((locale, index) => {
    if (!value.supportedLocales.includes(locale)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["rtlLocales", index], message: "RTL locales must also be supported locales." });
    }
  });
});

const organizationPolicySchema = z.object({
  schemaVersion: z.literal(ORGANIZATION_POLICY_SCHEMA_VERSION),
  localization: localizationPolicySchema,
  platforms: z.object({
    enabled: uniqueStrings(z.enum(ORGANIZATION_REPOSITORY_PLATFORMS), ORGANIZATION_REPOSITORY_PLATFORMS.length, 1),
    framePresets: uniqueStrings(z.enum(["desktop", "phone", "tablet"]), 3, 1),
  }).strict(),
  designSystem: z.object({
    requirePublishedRelease: z.boolean(),
    allowDetachedTemplates: z.boolean(),
    approvedFontFamilies: uniqueStrings(z.string().trim().min(1).max(120), 100, 1),
    approvedIconSets: uniqueStrings(z.string().trim().min(1).max(120), 50, 1),
  }).strict(),
  assets: z.object({
    enabled: z.boolean().default(true),
    allowedMimeTypes: uniqueStrings(z.enum(["image/png", "image/jpeg", "image/webp"]), 3, 1),
    maximumBytes: z.number().int().min(1_024).max(64 * 1_024 * 1_024),
    maximumPixels: z.number().int().min(1).max(100_000_000),
    allowAnimatedImages: z.literal(false),
    allowRemoteUrls: z.literal(false),
    allowSvgUpload: z.literal(false),
  }).strict(),
  naming: z.object({
    projectConvention: z.enum(["sentence_case", "title_case", "kebab_case"]),
    componentConvention: z.enum(["pascal_case", "sentence_case", "kebab_case"]),
    tokenConvention: z.enum(["dot_case", "kebab_case"]),
  }).strict(),
  accessibility: z.object({
    minimumContrastRatio: z.number().min(1).max(21),
    minimumLargeTextContrastRatio: z.number().min(1).max(21),
    minimumTouchTargetPx: z.number().int().min(24).max(96),
    requireAlternativeText: z.boolean(),
    requireFocusState: z.boolean(),
    requireHighContrastContext: z.boolean(),
  }).strict(),
  agents: z.object({
    enabled: z.boolean(),
    allowLegacyEnvironmentToken: z.boolean().default(true),
    allowedAdapters: uniqueStrings(z.enum(["codex", "generic_mcp"]), 2, 1),
    allowedScopes: uniqueStrings(z.enum(ORGANIZATION_AGENT_SCOPES), ORGANIZATION_AGENT_SCOPES.length, 1),
    maximumExpirySeconds: z.number().int().min(300).max(2_592_000),
    maximumActiveConnections: z.number().int().min(1).max(100),
    requireProjectRestriction: z.boolean(),
  }).strict(),
  repositories: z.object({
    enabled: z.boolean(),
    allowedPlatforms: uniqueStrings(z.enum(ORGANIZATION_REPOSITORY_PLATFORMS), ORGANIZATION_REPOSITORY_PLATFORMS.length, 1),
    requireExplicitGrant: z.literal(true),
    readOnlyByDefault: z.literal(true),
    maximumInventoryBytes: z.number().int().min(1_024).max(1_048_576),
    maximumInventoryEntities: z.number().int().min(1).max(10_000),
    excludedPatterns: uniqueStrings(z.string().trim().min(1).max(240), 100),
  }).strict(),
  backups: z.object({
    enabled: z.boolean(),
    requireVerifiedBeforeMigration: z.literal(true),
    requireOffHostCopy: z.boolean(),
    scheduleUtc: z.string().regex(/^\d{1,2} \d{1,2} \* \* \*$/),
    retention: z.object({
      daily: z.number().int().min(1).max(3_650),
      weekly: z.number().int().min(1).max(520),
      monthly: z.number().int().min(1).max(120),
    }).strict(),
  }).strict(),
  identity: z.object({
    roleMappings: z.array(z.object({
      claim: z.enum(["identity", "external_id", "trusted_user"]),
      value: z.string().trim().min(1).max(240),
      role: humanRoleSchema,
    }).strict()).max(100),
  }).strict(),
  audit: z.object({
    retentionDays: z.number().int().min(30).max(3_650),
    includeReadEvents: z.boolean(),
  }).strict(),
  exports: z.object({
    allowPortableBundles: z.boolean(),
    allowedTokenFormats: uniqueStrings(z.enum(["dtcg", "css", "typescript", "android", "compose", "swift", "flutter"]), 7, 1),
    includePreviewsByDefault: z.boolean(),
  }).strict(),
}).strict();

export const OrganizationPolicySchema = organizationPolicySchema.superRefine((value, context) => {
  if (value.accessibility.minimumLargeTextContrastRatio > value.accessibility.minimumContrastRatio) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accessibility", "minimumLargeTextContrastRatio"],
      message: "Large-text contrast cannot exceed the normal-text contrast requirement.",
    });
  }
  if (value.agents.enabled && !value.agents.allowedScopes.includes("organization_policy:read")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agents", "allowedScopes"],
      message: "Enabled agents must be allowed to read the organization policy.",
    });
  }
  const schedule = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(value.backups.scheduleUtc);
  const minute = Number(schedule?.[1]);
  const hour = Number(schedule?.[2]);
  if (!schedule || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["backups", "scheduleUtc"],
      message: "Backup schedule hour or minute is outside the valid UTC range.",
    });
  }
});

export type OrganizationPolicy = z.infer<typeof OrganizationPolicySchema>;

export const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = OrganizationPolicySchema.parse({
  schemaVersion: ORGANIZATION_POLICY_SCHEMA_VERSION,
  localization: {
    defaultLocale: "en-US",
    supportedLocales: ["en-US", "fa-IR"],
    defaultDirection: "auto",
    rtlLocales: ["fa-IR"],
  },
  platforms: {
    enabled: [...ORGANIZATION_REPOSITORY_PLATFORMS],
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
    maximumBytes: 16 * 1_024 * 1_024,
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
    allowedPlatforms: [...ORGANIZATION_REPOSITORY_PLATFORMS],
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
});

export const FAIL_CLOSED_ORGANIZATION_POLICY: OrganizationPolicy = OrganizationPolicySchema.parse({
  ...structuredClone(DEFAULT_ORGANIZATION_POLICY),
  assets: { ...DEFAULT_ORGANIZATION_POLICY.assets, enabled: false },
  agents: { ...DEFAULT_ORGANIZATION_POLICY.agents, enabled: false, allowLegacyEnvironmentToken: false },
  repositories: { ...DEFAULT_ORGANIZATION_POLICY.repositories, enabled: false },
  backups: { ...DEFAULT_ORGANIZATION_POLICY.backups, enabled: false },
  exports: { ...DEFAULT_ORGANIZATION_POLICY.exports, allowPortableBundles: false },
});

interface OrganizationPolicyRow {
  id: string;
  name: string;
  config_json: string;
  updated_at: string;
}

export interface LoadedOrganizationPolicy {
  organizationId: string;
  organizationName: string;
  policy: OrganizationPolicy;
  policyHash: string;
  configurationHash: string;
  source: "default" | "stored" | "legacy_quarantined" | "corrupt_fail_closed";
  diagnostics: Array<{ code: string; severity: "warning" | "error"; message: string }>;
  updatedAt: string;
}

const organizationPolicyConfigurationEntrySchema = z.object({
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(500),
  source: z.enum(["default", "stored", "legacy_quarantined", "corrupt_fail_closed"]),
  configuration_hash: z.string().regex(/^[a-f0-9]{64}$/),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: OrganizationPolicySchema,
}).strict();

export const OrganizationPolicyBackupConfigurationSchema = z.object({
  format: z.literal("formaspec-organization-config"),
  schema_version: z.literal(ORGANIZATION_POLICY_SCHEMA_VERSION),
  organizations: z.array(organizationPolicyConfigurationEntrySchema).min(1).max(16),
}).strict();

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalOrganizationPolicy(policy: OrganizationPolicy): string {
  return canonicalJson(JSON.parse(JSON.stringify(policy)) as unknown);
}

export function parseOrganizationPolicy(value: unknown): OrganizationPolicy {
  let inputBytes: number;
  try {
    inputBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new DomainError("VALIDATION_FAILED", "The organization policy is not valid JSON data.", 422);
  }
  if (inputBytes > ORGANIZATION_POLICY_MAX_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "The organization policy exceeds 256 KiB.", 413);
  }
  const parsed = OrganizationPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "The organization policy is invalid.", 422, {
      details: {
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  return parsed.data;
}

export function loadOrganizationPolicy(sqlite: Database.Database, organizationId: string): LoadedOrganizationPolicy {
  const row = sqlite.prepare(
    "SELECT id, name, config_json, updated_at FROM organizations WHERE id = ?",
  ).get(organizationId) as OrganizationPolicyRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "Organization not found.", 404);
  const configurationHash = sha256Text(row.config_json);
  if (row.config_json === "{}") {
    const json = canonicalOrganizationPolicy(DEFAULT_ORGANIZATION_POLICY);
    return {
      organizationId: row.id,
      organizationName: row.name,
      policy: DEFAULT_ORGANIZATION_POLICY,
      policyHash: sha256Text(json),
      configurationHash,
      source: "default",
      diagnostics: [],
      updatedAt: row.updated_at,
    };
  }
  try {
    const parsed = OrganizationPolicySchema.safeParse(JSON.parse(row.config_json) as unknown);
    if (!parsed.success) throw parsed.error;
    const json = canonicalOrganizationPolicy(parsed.data);
    return {
      organizationId: row.id,
      organizationName: row.name,
      policy: parsed.data,
      policyHash: sha256Text(json),
      configurationHash,
      source: "stored",
      diagnostics: [],
      updatedAt: row.updated_at,
    };
  } catch {
    const governed = sqlite.prepare(
      `SELECT 1 FROM audit_events
       WHERE organization_id = ? AND action = 'organization_policy.update' LIMIT 1`,
    ).get(row.id) !== undefined;
    const policy = governed ? FAIL_CLOSED_ORGANIZATION_POLICY : DEFAULT_ORGANIZATION_POLICY;
    const json = canonicalOrganizationPolicy(policy);
    return {
      organizationId: row.id,
      organizationName: row.name,
      policy,
      policyHash: sha256Text(json),
      configurationHash,
      source: governed ? "corrupt_fail_closed" : "legacy_quarantined",
      diagnostics: [governed ? {
        code: "ORGANIZATION_POLICY_CORRUPT_FAIL_CLOSED",
        severity: "error",
        message: "The stored organization policy failed validation. Agent, repository, asset, and portable-export policy gates are closed until an administrator saves a valid replacement.",
      } : {
        code: "LEGACY_ORGANIZATION_CONFIG_QUARANTINED",
        severity: "warning",
        message: "The legacy organization configuration is preserved in the database but is not interpreted or exported. Saving an approved policy replaces it.",
      }],
      updatedAt: row.updated_at,
    };
  }
}

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function yamlLines(value: unknown, indent = 0): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((entry) => {
      if (entry !== null && typeof entry === "object") {
        const children = yamlLines(entry, indent + 2);
        return [`${prefix}-`, ...children];
      }
      return [`${prefix}- ${yamlScalar(entry as string | number | boolean | null)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, entry]) => {
      if (entry !== null && typeof entry === "object") {
        return [`${prefix}${key}:`, ...yamlLines(entry, indent + 2)];
      }
      return [`${prefix}${key}: ${yamlScalar(entry as string | number | boolean | null)}`];
    });
  }
  return [`${prefix}${yamlScalar(value as string | number | boolean | null)}`];
}

function configurationEntry(result: LoadedOrganizationPolicy) {
  return {
    id: result.organizationId,
    name: result.organizationName,
    source: result.source,
    configuration_hash: result.configurationHash,
    policy_hash: result.policyHash,
    policy: result.policy,
  };
}

export function organizationPolicyYaml(result: LoadedOrganizationPolicy): string {
  const document = {
    format: "formaspec-organization-config",
    schema_version: ORGANIZATION_POLICY_SCHEMA_VERSION,
    organization: configurationEntry(result),
  };
  return `${yamlLines(document).join("\n")}\n`;
}

export function organizationPolicyBackupConfiguration(sqlite: Database.Database): z.infer<typeof OrganizationPolicyBackupConfigurationSchema> {
  const rows = sqlite.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>;
  const configuration = {
    format: "formaspec-organization-config" as const,
    schema_version: ORGANIZATION_POLICY_SCHEMA_VERSION,
    organizations: rows.map((row) => configurationEntry(loadOrganizationPolicy(sqlite, row.id))),
  };
  return OrganizationPolicyBackupConfigurationSchema.parse(configuration);
}

export function organizationPolicyBackupJson(sqlite: Database.Database): string {
  return `${JSON.stringify(organizationPolicyBackupConfiguration(sqlite), null, 2)}\n`;
}

export function verifyOrganizationPolicyBackupConfiguration(
  sqlite: Database.Database,
  contents: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Backup organization configuration is not valid JSON-compatible YAML.", 422);
  }
  const configuration = OrganizationPolicyBackupConfigurationSchema.safeParse(parsed);
  if (!configuration.success) {
    throw new DomainError("VALIDATION_FAILED", "Backup organization configuration is invalid.", 422, {
      details: {
        issues: configuration.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  const expected = organizationPolicyBackupConfiguration(sqlite);
  if (canonicalJson(configuration.data) !== canonicalJson(expected)) {
    throw new DomainError("VALIDATION_FAILED", "Backup organization configuration does not match the database policy ledger.", 422);
  }
}
