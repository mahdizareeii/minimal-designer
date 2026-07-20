import { randomUUID } from "node:crypto";

import {
  ComponentDefinitionSchema,
  ComponentDefinitionIdSchema,
  DesignSystemIdSchema,
  DesignSystemReleaseIdSchema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  TokenIdSchema,
  resolveDesignToken,
  type ComponentDefinition,
  type DesignSystemToken,
} from "@designer/core";
import { z } from "zod";

import {
  appendAuditEvent,
  assertProjectAccess,
  assertScope,
  resolveAccess,
  type AccessContext,
} from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { canonicalJson, hashPayload } from "./ids.js";

const MAX_ENTITY_JSON_BYTES = 1_048_576;
const MAX_RELEASE_JSON_BYTES = 8 * 1_048_576;
const DEFAULT_UPGRADE_PREVIEW_TTL_SECONDS = 900;

const tokenStatusSchema = z.enum(["draft", "published", "deprecated"]);
const releaseStatusSchema = z.enum(["draft", "published", "deprecated"]);
const releaseTokenVersionSchema = z.object({
  token_id: TokenIdSchema,
  version: z.number().int().positive(),
}).strict();
const releaseComponentVersionSchema = z.object({
  component_definition_id: ComponentDefinitionIdSchema,
  version: z.number().int().positive(),
}).strict();

export type DesignSystemEntityStatus = z.infer<typeof tokenStatusSchema>;
export type DesignSystemReleaseStatus = z.infer<typeof releaseStatusSchema>;

export interface DesignSystemDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  safety: "safe" | "review_required" | "blocked";
  message: string;
  entityKind?: "release" | "token" | "component" | "project";
  entityId?: string;
  path?: string;
}

const diagnosticSchema: z.ZodType<DesignSystemDiagnostic> = z.object({
  code: z.string().min(1).max(160),
  severity: z.enum(["info", "warning", "error"]),
  safety: z.enum(["safe", "review_required", "blocked"]),
  message: z.string().min(1).max(4_000),
  entityKind: z.enum(["release", "token", "component", "project"]).optional(),
  entityId: z.string().min(1).max(300).optional(),
  path: z.string().max(500).optional(),
}).strict();

const releaseEnvelopeSchema = z.object({
  format: z.literal("formaspec-design-system-release"),
  format_version: z.literal(1),
  release: DesignSystemReleaseSchema,
  token_versions: z.array(releaseTokenVersionSchema).max(20_000),
  component_versions: z.array(releaseComponentVersionSchema).max(5_000),
  diagnostics: z.array(diagnosticSchema).max(20_000),
}).strict();

const upgradePreviewPayloadSchema = z.object({
  format: z.literal("formaspec-design-system-upgrade-preview"),
  format_version: z.literal(1),
  design_version: z.number().int().positive(),
  design_revision_id: z.string().min(1).max(300),
  diagnostics: z.array(diagnosticSchema).max(20_000),
}).strict();

interface DesignSystemRow {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface TokenVersionRow {
  design_system_id: string;
  token_id: string;
  version: number;
  status: DesignSystemEntityStatus;
  token_json: string;
  created_by: string;
  created_at: string;
}

interface ComponentVersionRow {
  design_system_id: string;
  component_id: string;
  version: number;
  status: DesignSystemEntityStatus;
  definition_json: string;
  replacement_component_id: string | null;
  created_by: string;
  created_at: string;
}

interface ReleaseRow {
  id: string;
  design_system_id: string;
  version: number;
  name: string;
  status: DesignSystemReleaseStatus;
  release_json: string;
  created_by: string;
  created_at: string;
  published_at: string | null;
}

interface ProjectPinRow {
  design_id: string;
  organization_id: string;
  design_system_id: string;
  release_id: string;
  release_version: number;
  pinned_by: string;
  pinned_at: string;
}

interface UpgradePreviewRow {
  id: string;
  organization_id: string;
  design_id: string;
  current_release_id: string | null;
  target_release_id: string;
  diagnostics_json: string;
  preview_hash: string;
  status: "ready" | "blocked" | "committed" | "expired";
  created_by: string;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
}

interface DesignRow {
  id: string;
  organization_id: string;
  current_version: number;
  current_revision_id: string;
}

export interface DesignSystemResult {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignSystemTokenVersionResult {
  designSystemId: string;
  tokenId: string;
  version: number;
  status: DesignSystemEntityStatus;
  token: DesignSystemToken;
  createdBy: string;
  createdAt: string;
}

export interface ComponentDefinitionVersionResult {
  designSystemId: string;
  componentId: string;
  version: number;
  status: DesignSystemEntityStatus;
  definition: ComponentDefinition;
  createdBy: string;
  createdAt: string;
}

export interface ComponentDefinitionCatalogResult extends ComponentDefinitionVersionResult {
  isLatest: boolean;
  versionCount: number;
  replacement: {
    componentId: string;
    version: number;
    status: DesignSystemEntityStatus;
    name: string;
  } | null;
  diagnostics: DesignSystemDiagnostic[];
}

export interface ComponentAuthoringPermissionResult {
  designSystemId: string;
  canAuthorComponents: boolean;
}

export interface DesignSystemReleaseResult {
  id: string;
  designSystemId: string;
  version: number;
  name: string;
  status: DesignSystemReleaseStatus;
  tokenVersions: Array<{ tokenId: string; version: number }>;
  componentVersions: Array<{ componentDefinitionId: string; version: number }>;
  diagnostics: DesignSystemDiagnostic[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface ProjectDesignSystemPinResult {
  designId: string;
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  pinnedBy: string;
  pinnedAt: string;
}

export interface DesignSystemUpgradePreviewResult {
  id: string;
  designId: string;
  currentReleaseId: string;
  targetReleaseId: string;
  designVersion: number;
  designRevisionId: string;
  diagnostics: DesignSystemDiagnostic[];
  previewHash: string;
  status: UpgradePreviewRow["status"];
  canCommit: boolean;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
}

export interface DesignSystemServiceOptions {
  now?: () => Date;
  upgradePreviewTtlSeconds?: number;
}

function generatedId(prefix: "system" | "release" | "upgrade"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function boundedText(value: string, label: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`, 422, {
      details: { minimumLength: allowEmpty ? 0 : 1, maximumLength: maximum },
    });
  }
  return normalized;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`, 422, {
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

function canonicalEntity<S extends z.ZodTypeAny>(schema: S, value: unknown, label: string, maximumBytes = MAX_ENTITY_JSON_BYTES): {
  value: z.output<S>;
  json: string;
} {
  const parsed = parseInput(schema, value, label);
  const json = canonicalJson(JSON.parse(JSON.stringify(parsed)) as unknown);
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `${label} exceeds its persisted size limit.`, 413, {
      details: { maximumBytes },
    });
  }
  return { value: parseInput(schema, JSON.parse(json) as unknown, label) as z.output<S>, json };
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class DesignSystemService {
  readonly upgradePreviewTtlSeconds: number;
  readonly #now: () => Date;

  constructor(
    readonly database: DesignerDatabase,
    options: DesignSystemServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.upgradePreviewTtlSeconds = options.upgradePreviewTtlSeconds ?? DEFAULT_UPGRADE_PREVIEW_TTL_SECONDS;
    if (!Number.isInteger(this.upgradePreviewTtlSeconds)
      || this.upgradePreviewTtlSeconds < 60
      || this.upgradePreviewTtlSeconds > 3_600) {
      throw new Error("Design-system upgrade preview TTL must be an integer from 60 to 3600 seconds.");
    }
  }

  createDesignSystem(actorId: string, input: { name: string; description?: string }): DesignSystemResult {
    const access = this.requireOrganizationAdmin(actorId);
    const name = boundedText(input.name, "Design-system name", 240);
    const description = boundedText(input.description ?? "", "Design-system description", 10_000, true);
    const id = DesignSystemIdSchema.parse(generatedId("system"));
    const now = this.nowIso();
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        `INSERT INTO design_systems
         (id, organization_id, name, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(id, access.organizationId, name, description, access.principalId, now, now);
      appendAuditEvent(this.database.sqlite, access, "design_system.create", "design_system", id, { name });
      return this.designSystemResult(this.requireDesignSystemRow(access, id));
    });
    return transaction.immediate();
  }

  updateDesignSystem(actorId: string, designSystemId: string, input: {
    expectedUpdatedAt: string;
    name?: string;
    description?: string;
    status?: "active" | "archived";
  }): DesignSystemResult {
    const access = this.requireOrganizationAdmin(actorId);
    const id = DesignSystemIdSchema.parse(designSystemId);
    const row = this.requireDesignSystemRow(access, id);
    if (row.updated_at !== input.expectedUpdatedAt) throw this.versionConflict("design system", input.expectedUpdatedAt, row.updated_at);
    if (row.status === "archived" && input.status === "active") {
      throw new DomainError("VALIDATION_FAILED", "Archived design systems cannot be reactivated.", 422);
    }
    if (input.name === undefined && input.description === undefined && input.status === undefined) {
      throw new DomainError("VALIDATION_FAILED", "At least one design-system field must change.", 422);
    }
    const name = input.name === undefined ? row.name : boundedText(input.name, "Design-system name", 240);
    const description = input.description === undefined
      ? row.description
      : boundedText(input.description, "Design-system description", 10_000, true);
    const status = input.status ?? row.status;
    const now = this.nextIsoAfter(row.updated_at);
    const transaction = this.database.sqlite.transaction(() => {
      const updated = this.database.sqlite.prepare(
        `UPDATE design_systems SET name = ?, description = ?, status = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND updated_at = ?`,
      ).run(name, description, status, now, id, access.organizationId, input.expectedUpdatedAt);
      if (updated.changes !== 1) {
        const current = this.requireDesignSystemRow(access, id);
        throw this.versionConflict("design system", input.expectedUpdatedAt, current.updated_at);
      }
      appendAuditEvent(this.database.sqlite, access, "design_system.update", "design_system", id, {
        nameChanged: name !== row.name,
        descriptionChanged: description !== row.description,
        statusFrom: row.status,
        statusTo: status,
      });
      return this.designSystemResult(this.requireDesignSystemRow(access, id));
    });
    return transaction.immediate();
  }

  readDesignSystem(actorId: string, designSystemId: string): DesignSystemResult {
    const access = this.resolveReadAccess(actorId);
    return this.designSystemResult(this.requireDesignSystemRow(access, DesignSystemIdSchema.parse(designSystemId)));
  }

  listDesignSystems(actorId: string, includeArchived = false): DesignSystemResult[] {
    const access = this.resolveReadAccess(actorId);
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM design_systems
       WHERE organization_id = ?${includeArchived ? "" : " AND status = 'active'"}
       ORDER BY updated_at DESC, id`,
    ).all(access.organizationId) as DesignSystemRow[];
    return rows.map((row) => this.designSystemResult(row));
  }

  createTokenVersion(actorId: string, designSystemId: string, input: {
    expectedLatestVersion: number;
    status: DesignSystemEntityStatus;
    token?: unknown;
  }): DesignSystemTokenVersionResult {
    const access = this.requireOrganizationAdmin(actorId);
    const system = this.requireActiveDesignSystem(access, designSystemId);
    const status = parseInput(tokenStatusSchema, input.status, "Token lifecycle status");
    const canonical = canonicalEntity(DesignSystemTokenSchema, input.token, "Design-system token");
    if ((status === "deprecated") !== canonical.value.deprecated) {
      throw new DomainError("VALIDATION_FAILED", "Token deprecated state must match its lifecycle status.", 422);
    }
    if (!Number.isInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedLatestVersion must be a non-negative integer.", 422);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const latestVersion = this.latestTokenVersion(system.id, canonical.value.id);
      if (latestVersion !== input.expectedLatestVersion) {
        throw this.numericVersionConflict("design-system token", input.expectedLatestVersion, latestVersion);
      }
      if (canonical.value.replacement_token_id) {
        this.requireLatestTokenRow(system.id, canonical.value.replacement_token_id);
      }
      const version = latestVersion + 1;
      const now = this.nowIso();
      this.database.sqlite.prepare(
        `INSERT INTO design_system_tokens
         (design_system_id, token_id, version, status, token_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(system.id, canonical.value.id, version, status, canonical.json, access.principalId, now);
      appendAuditEvent(this.database.sqlite, access, "design_system.token_version.create", "design_system_token", canonical.value.id, {
        designSystemId: system.id,
        version,
        status,
      });
      return this.tokenVersionResult(this.requireTokenRow(system.id, canonical.value.id, version));
    });
    return transaction.immediate();
  }

  createComponentVersion(actorId: string, designSystemId: string, input: {
    expectedLatestVersion: number;
    definition?: unknown;
  }): ComponentDefinitionVersionResult {
    const access = this.requireComponentAuthor(actorId);
    const system = this.requireActiveDesignSystem(access, designSystemId);
    const canonical = canonicalEntity(ComponentDefinitionSchema, input.definition, "Component definition");
    if (!Number.isInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedLatestVersion must be a non-negative integer.", 422);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const latestVersion = this.latestComponentVersion(system.id, canonical.value.id);
      if (latestVersion !== input.expectedLatestVersion) {
        throw this.numericVersionConflict("component definition", input.expectedLatestVersion, latestVersion);
      }
      const version = latestVersion + 1;
      if (canonical.value.version !== version) {
        throw new DomainError("VALIDATION_FAILED", `Component definition version must be ${version}.`, 422);
      }
      if (canonical.value.replacement_component_id) {
        this.requireLatestComponentRow(system.id, canonical.value.replacement_component_id);
      }
      const now = this.nowIso();
      this.database.sqlite.prepare(
        `INSERT INTO component_definitions
         (design_system_id, component_id, version, status, definition_json, replacement_component_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        system.id,
        canonical.value.id,
        version,
        canonical.value.status,
        canonical.json,
        canonical.value.replacement_component_id ?? null,
        access.principalId,
        now,
      );
      appendAuditEvent(this.database.sqlite, access, "design_system.component_version.create", "component_definition", canonical.value.id, {
        designSystemId: system.id,
        version,
        status: canonical.value.status,
      });
      return this.componentVersionResult(this.requireComponentRow(system.id, canonical.value.id, version));
    });
    return transaction.immediate();
  }

  listComponentDefinitions(
    actorId: string,
    designSystemId: string,
    includeHistory = false,
  ): ComponentDefinitionCatalogResult[] {
    const access = this.resolveReadAccess(actorId);
    const system = this.requireDesignSystemRow(access, DesignSystemIdSchema.parse(designSystemId));
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM component_definitions
       WHERE design_system_id = ?
       ORDER BY component_id, version DESC`,
    ).all(system.id) as ComponentVersionRow[];
    const latestByComponent = new Map<string, ComponentVersionRow>();
    const versionCounts = new Map<string, number>();
    for (const row of rows) {
      if (!latestByComponent.has(row.component_id)) latestByComponent.set(row.component_id, row);
      versionCounts.set(row.component_id, (versionCounts.get(row.component_id) ?? 0) + 1);
    }
    const selected = includeHistory ? rows : [...latestByComponent.values()];
    return selected
      .map((row) => this.componentCatalogResult(
        row,
        latestByComponent,
        versionCounts.get(row.component_id) ?? 1,
      ))
      .sort((left, right) => left.definition.name.localeCompare(right.definition.name)
        || left.componentId.localeCompare(right.componentId)
        || right.version - left.version);
  }

  readComponentAuthoringPermission(actorId: string, designSystemId: string): ComponentAuthoringPermissionResult {
    const access = this.resolveReadAccess(actorId);
    const system = this.requireDesignSystemRow(access, DesignSystemIdSchema.parse(designSystemId));
    return {
      designSystemId: system.id,
      canAuthorComponents: system.status === "active"
        && (access.role === "organization_admin" || access.role === "design_editor"),
    };
  }

  transitionComponentLifecycle(actorId: string, designSystemId: string, componentId: string, input: {
    expectedLatestVersion: number;
    targetStatus: "published" | "deprecated";
    replacementComponentId?: string | null;
  }): ComponentDefinitionVersionResult {
    const access = this.requireComponentAuthor(actorId);
    const system = this.requireActiveDesignSystem(access, designSystemId);
    const id = ComponentDefinitionIdSchema.parse(componentId);
    if (!Number.isInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 1) {
      throw new DomainError("VALIDATION_FAILED", "expectedLatestVersion must be a positive integer.", 422);
    }
    const latest = this.requireLatestComponentRow(system.id, id);
    if (latest.version !== input.expectedLatestVersion) {
      throw this.numericVersionConflict("component definition", input.expectedLatestVersion, latest.version);
    }
    if (latest.status === "deprecated") {
      throw new DomainError("VALIDATION_FAILED", "Deprecated components cannot transition to another lifecycle state.", 422);
    }
    if (input.targetStatus === latest.status) {
      throw new DomainError("VALIDATION_FAILED", `Component ${id} is already ${latest.status}.`, 422);
    }
    if (input.targetStatus === "published" && latest.status !== "draft") {
      throw new DomainError("VALIDATION_FAILED", "Only the latest draft component version can be published.", 422);
    }

    let replacementComponentId: string | undefined;
    if (input.targetStatus === "published") {
      if (input.replacementComponentId !== undefined && input.replacementComponentId !== null) {
        throw new DomainError("VALIDATION_FAILED", "Published components cannot declare a deprecation replacement.", 422);
      }
    } else if (input.replacementComponentId !== undefined && input.replacementComponentId !== null) {
      replacementComponentId = ComponentDefinitionIdSchema.parse(input.replacementComponentId);
      const replacement = this.requireLatestComponentRow(system.id, replacementComponentId);
      if (replacement.status !== "published") {
        throw new DomainError("VALIDATION_FAILED", "A component replacement must be a published component.", 422);
      }
    }

    const current = this.componentVersionResult(latest);
    const definition = structuredClone(current.definition);
    definition.version = latest.version + 1;
    definition.status = input.targetStatus;
    if (replacementComponentId) definition.replacement_component_id = replacementComponentId;
    else delete definition.replacement_component_id;
    return this.createComponentVersion(actorId, system.id, {
      expectedLatestVersion: latest.version,
      definition,
    });
  }

  createRelease(actorId: string, designSystemId: string, input: {
    expectedLatestVersion: number;
    name: string;
    status: DesignSystemReleaseStatus;
    tokenVersions: Array<{ tokenId: string; version: number }>;
    componentVersions: Array<{ componentDefinitionId: string; version: number }>;
  }): DesignSystemReleaseResult {
    const access = this.requireOrganizationAdmin(actorId);
    const system = this.requireActiveDesignSystem(access, designSystemId);
    const name = boundedText(input.name, "Release name", 240);
    const status = parseInput(releaseStatusSchema, input.status, "Release status");
    if (!Number.isInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedLatestVersion must be a non-negative integer.", 422);
    }
    const tokenVersions = parseInput(z.array(z.object({
      tokenId: TokenIdSchema,
      version: z.number().int().positive(),
    }).strict()).max(20_000), input.tokenVersions, "Release token versions");
    const componentVersions = parseInput(z.array(z.object({
      componentDefinitionId: ComponentDefinitionIdSchema,
      version: z.number().int().positive(),
    }).strict()).max(5_000), input.componentVersions, "Release component versions");
    const duplicateTokens = duplicateValues(tokenVersions.map((item) => item.tokenId));
    const duplicateComponents = duplicateValues(componentVersions.map((item) => item.componentDefinitionId));
    if (duplicateTokens.length > 0 || duplicateComponents.length > 0) {
      throw new DomainError("VALIDATION_FAILED", "A release may select each token and component only once.", 422, {
        details: { duplicateTokenIds: duplicateTokens, duplicateComponentIds: duplicateComponents },
      });
    }

    const transaction = this.database.sqlite.transaction(() => {
      const latestVersion = this.latestReleaseVersion(system.id);
      if (latestVersion !== input.expectedLatestVersion) {
        throw this.numericVersionConflict("design-system release", input.expectedLatestVersion, latestVersion);
      }
      const selectedTokens = tokenVersions.map((item) => this.requireTokenRow(system.id, item.tokenId, item.version));
      const selectedComponents = componentVersions.map((item) =>
        this.requireComponentRow(system.id, item.componentDefinitionId, item.version));
      const diagnostics = this.releaseDiagnostics(selectedTokens, selectedComponents, status);
      if (status === "published" && diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new DomainError("VALIDATION_FAILED", "A published release contains blocking diagnostics.", 422, {
          details: { diagnostics },
        });
      }
      const version = latestVersion + 1;
      const now = this.nowIso();
      const releaseId = DesignSystemReleaseIdSchema.parse(generatedId("release"));
      const normalizedTokenVersions = [...tokenVersions]
        .sort((left, right) => left.tokenId.localeCompare(right.tokenId) || left.version - right.version)
        .map((item) => ({ token_id: item.tokenId, version: item.version }));
      const normalizedComponentVersions = [...componentVersions]
        .sort((left, right) => left.componentDefinitionId.localeCompare(right.componentDefinitionId) || left.version - right.version)
        .map((item) => ({ component_definition_id: item.componentDefinitionId, version: item.version }));
      const release = DesignSystemReleaseSchema.parse({
        id: releaseId,
        design_system_id: system.id,
        version,
        name,
        status,
        token_ids: normalizedTokenVersions.map((item) => item.token_id),
        component_versions: normalizedComponentVersions,
        created_at: now,
        ...(status === "published" ? { published_at: now } : {}),
      });
      const envelope = canonicalEntity(releaseEnvelopeSchema, {
        format: "formaspec-design-system-release",
        format_version: 1,
        release,
        token_versions: normalizedTokenVersions,
        component_versions: normalizedComponentVersions,
        diagnostics,
      }, "Design-system release", MAX_RELEASE_JSON_BYTES);
      this.database.sqlite.prepare(
        `INSERT INTO design_system_releases
         (id, design_system_id, version, name, status, release_json, created_by, created_at, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        releaseId,
        system.id,
        version,
        name,
        status,
        envelope.json,
        access.principalId,
        now,
        status === "published" ? now : null,
      );
      appendAuditEvent(this.database.sqlite, access, "design_system.release.create", "design_system_release", releaseId, {
        designSystemId: system.id,
        version,
        status,
        tokenCount: normalizedTokenVersions.length,
        componentCount: normalizedComponentVersions.length,
        diagnosticCount: diagnostics.length,
      });
      return this.releaseResult(this.requireReleaseRow(access, releaseId));
    });
    return transaction.immediate();
  }

  readRelease(actorId: string, releaseId: string): DesignSystemReleaseResult {
    const access = this.resolveReadAccess(actorId);
    return this.releaseResult(this.requireReleaseRow(access, DesignSystemReleaseIdSchema.parse(releaseId)));
  }

  listReleases(actorId: string, designSystemId: string): DesignSystemReleaseResult[] {
    const access = this.resolveReadAccess(actorId);
    const system = this.requireDesignSystemRow(access, DesignSystemIdSchema.parse(designSystemId));
    const rows = this.database.sqlite.prepare(
      "SELECT * FROM design_system_releases WHERE design_system_id = ? ORDER BY version DESC",
    ).all(system.id) as ReleaseRow[];
    return rows.map((row) => this.releaseResult(row));
  }

  pinProject(actorId: string, input: {
    designId: string;
    releaseId: string;
    expectedCurrentReleaseId: string | null;
  }): ProjectDesignSystemPinResult {
    const access = this.requireOrganizationAdmin(actorId);
    const design = this.requireDesignRow(access, input.designId);
    const release = this.requireReleaseRow(access, DesignSystemReleaseIdSchema.parse(input.releaseId));
    const system = this.requireActiveDesignSystem(access, release.design_system_id);
    if (release.status !== "published") {
      throw new DomainError("VALIDATION_FAILED", "Projects can pin only published design-system releases.", 422);
    }
    const expected = input.expectedCurrentReleaseId === null
      ? null
      : DesignSystemReleaseIdSchema.parse(input.expectedCurrentReleaseId);
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.projectPinRow(access, design.id);
      if ((current?.release_id ?? null) !== expected) {
        throw new DomainError("VERSION_CONFLICT", "The project design-system pin changed.", 409, {
          retryable: true,
          details: { expectedReleaseId: expected, currentReleaseId: current?.release_id ?? null },
        });
      }
      if (current?.release_id === release.id) return this.projectPinResult(current);
      if (current) {
        throw new DomainError(
          "PREVIEW_NOT_COMMITTABLE",
          "Existing project pins can change only through an exact design-system upgrade preview.",
          422,
          { details: { currentReleaseId: current.release_id, targetReleaseId: release.id } },
        );
      }
      const now = this.nowIso();
      this.database.sqlite.prepare(
        `INSERT INTO project_design_system_pins
         (design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(design_id) DO UPDATE SET
           organization_id = excluded.organization_id,
           design_system_id = excluded.design_system_id,
           release_id = excluded.release_id,
           release_version = excluded.release_version,
           pinned_by = excluded.pinned_by,
           pinned_at = excluded.pinned_at`,
      ).run(design.id, access.organizationId, system.id, release.id, release.version, access.principalId, now);
      appendAuditEvent(this.database.sqlite, access, "design_system.project_pin", "design", design.id, {
        previousReleaseId: null,
        releaseId: release.id,
        releaseVersion: release.version,
        designSystemId: system.id,
      });
      return this.projectPinResult(this.requireProjectPinRow(access, design.id));
    });
    return transaction.immediate();
  }

  readProjectPin(actorId: string, designId: string): ProjectDesignSystemPinResult {
    const access = this.resolveReadAccess(actorId);
    const design = this.requireDesignRow(access, designId);
    return this.projectPinResult(this.requireProjectPinRow(access, design.id));
  }

  previewProjectUpgrade(actorId: string, input: {
    designId: string;
    targetReleaseId: string;
  }): DesignSystemUpgradePreviewResult {
    const access = this.requireOrganizationAdmin(actorId);
    const transaction = this.database.sqlite.transaction(() => {
      const nowDate = this.#now();
      const now = nowDate.toISOString();
      this.expireUpgradePreviews(now);
      const design = this.requireDesignRow(access, input.designId);
      const pin = this.requireProjectPinRow(access, design.id);
      const current = this.requireReleaseRow(access, pin.release_id);
      const target = this.requireReleaseRow(access, DesignSystemReleaseIdSchema.parse(input.targetReleaseId));
      this.requireActiveDesignSystem(access, current.design_system_id);
      if (target.design_system_id !== current.design_system_id) {
        throw new DomainError("VALIDATION_FAILED", "An upgrade target must belong to the currently pinned design system.", 422);
      }
      if (target.status !== "published") {
        throw new DomainError("VALIDATION_FAILED", "An upgrade target must be a published release.", 422);
      }
      if (target.version <= current.version) {
        throw new DomainError("VALIDATION_FAILED", "An upgrade target must have a newer release version.", 422);
      }
      const plan = this.buildUpgradePlan(design, current, target);
      const id = generatedId("upgrade");
      const expiresAt = new Date(nowDate.getTime() + this.upgradePreviewTtlSeconds * 1_000).toISOString();
      const status = plan.diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "blocked" : "ready";
      this.database.sqlite.prepare(
        `INSERT INTO design_system_upgrade_previews
         (id, organization_id, design_id, current_release_id, target_release_id, diagnostics_json,
          preview_hash, status, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        access.organizationId,
        design.id,
        current.id,
        target.id,
        plan.payloadJson,
        plan.previewHash,
        status,
        access.principalId,
        now,
        expiresAt,
      );
      appendAuditEvent(this.database.sqlite, access, "design_system.upgrade_preview.create", "design_system_upgrade_preview", id, {
        designId: design.id,
        currentReleaseId: current.id,
        targetReleaseId: target.id,
        previewHash: plan.previewHash,
        status,
        diagnosticCount: plan.diagnostics.length,
      });
      return this.upgradePreviewResult(this.requireUpgradePreviewRow(access, id));
    });
    return transaction.immediate();
  }

  readUpgradePreview(actorId: string, previewId: string): DesignSystemUpgradePreviewResult {
    const access = this.resolveReadAccess(actorId);
    this.expireUpgradePreviews(this.nowIso());
    return this.upgradePreviewResult(this.requireUpgradePreviewRow(access, previewId));
  }

  commitProjectUpgrade(actorId: string, input: {
    previewId: string;
    expectedPreviewHash: string;
  }): { preview: DesignSystemUpgradePreviewResult; pin: ProjectDesignSystemPinResult } {
    const access = this.requireOrganizationAdmin(actorId);
    if (!/^[a-f0-9]{64}$/.test(input.expectedPreviewHash)) {
      throw new DomainError("VALIDATION_FAILED", "expectedPreviewHash must be a SHA-256 value.", 422);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const now = this.nowIso();
      this.expireUpgradePreviews(now);
      const preview = this.requireUpgradePreviewRow(access, input.previewId, true);
      if (preview.status === "committed") {
        throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The design-system upgrade preview was already committed.", 409);
      }
      if (preview.status === "expired" || preview.expires_at <= now) {
        throw new DomainError("PREVIEW_EXPIRED", "The design-system upgrade preview expired.", 410, { retryable: true });
      }
      if (preview.status === "blocked") {
        throw new DomainError("PREVIEW_NOT_COMMITTABLE", "The design-system upgrade preview has blocking diagnostics.", 422, {
          details: { diagnostics: this.previewPayload(preview).diagnostics },
        });
      }
      if (preview.preview_hash !== input.expectedPreviewHash) {
        throw new DomainError("VERSION_CONFLICT", "The upgrade preview hash does not match.", 409, {
          details: { expectedPreviewHash: input.expectedPreviewHash, actualPreviewHash: preview.preview_hash },
        });
      }
      const design = this.requireDesignRow(access, preview.design_id);
      const pin = this.requireProjectPinRow(access, design.id);
      if (pin.release_id !== preview.current_release_id) {
        throw new DomainError("VERSION_CONFLICT", "The project design-system pin changed after preview.", 409, {
          retryable: true,
          details: { previewReleaseId: preview.current_release_id, currentReleaseId: pin.release_id },
        });
      }
      const current = this.requireReleaseRow(access, pin.release_id);
      const target = this.requireReleaseRow(access, preview.target_release_id);
      this.requireActiveDesignSystem(access, current.design_system_id);
      const plan = this.buildUpgradePlan(design, current, target);
      if (plan.previewHash !== preview.preview_hash || plan.payloadJson !== preview.diagnostics_json) {
        throw new DomainError("VERSION_CONFLICT", "The design or upgrade diagnostics changed after preview.", 409, {
          retryable: true,
          details: { previewHash: preview.preview_hash, currentPreviewHash: plan.previewHash },
        });
      }
      const pinUpdated = this.database.sqlite.prepare(
        `UPDATE project_design_system_pins
         SET release_id = ?, release_version = ?, pinned_by = ?, pinned_at = ?
         WHERE design_id = ? AND organization_id = ? AND release_id = ?`,
      ).run(target.id, target.version, access.principalId, now, design.id, access.organizationId, current.id);
      if (pinUpdated.changes !== 1) throw new DomainError("VERSION_CONFLICT", "The project pin changed during upgrade commit.", 409);
      const previewUpdated = this.database.sqlite.prepare(
        `UPDATE design_system_upgrade_previews SET status = 'committed', committed_at = ?
         WHERE id = ? AND status = 'ready'`,
      ).run(now, preview.id);
      if (previewUpdated.changes !== 1) throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The upgrade preview was already committed.", 409);
      appendAuditEvent(this.database.sqlite, access, "design_system.upgrade_commit", "design", design.id, {
        previewId: preview.id,
        previousReleaseId: current.id,
        targetReleaseId: target.id,
        targetReleaseVersion: target.version,
        previewHash: preview.preview_hash,
      });
      return {
        preview: this.upgradePreviewResult(this.requireUpgradePreviewRow(access, preview.id, true)),
        pin: this.projectPinResult(this.requireProjectPinRow(access, design.id)),
      };
    });
    return transaction.immediate();
  }

  private requireOrganizationAdmin(actorId: string): AccessContext {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "organization_admin") {
      throw new DomainError("FORBIDDEN", "Organization Administrator permission is required.", 403);
    }
    return access;
  }

  private requireComponentAuthor(actorId: string): AccessContext {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "organization_admin" && access.role !== "design_editor") {
      throw new DomainError(
        "FORBIDDEN",
        "Organization Administrator or Design Editor permission is required to author components.",
        403,
      );
    }
    return access;
  }

  private resolveReadAccess(actorId: string): AccessContext {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design_system:read");
    return access;
  }

  private requireDesignSystemRow(access: AccessContext, designSystemId: string): DesignSystemRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM design_systems WHERE id = ? AND organization_id = ?",
    ).get(designSystemId, access.organizationId) as DesignSystemRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design system not found.", 404);
    return row;
  }

  private requireActiveDesignSystem(access: AccessContext, designSystemId: string): DesignSystemRow {
    const id = DesignSystemIdSchema.parse(designSystemId);
    const row = this.requireDesignSystemRow(access, id);
    if (row.status !== "active") throw new DomainError("VALIDATION_FAILED", "The design system is archived.", 409);
    return row;
  }

  private requireDesignRow(access: AccessContext, designId: string): DesignRow {
    const row = this.database.sqlite.prepare(
      "SELECT id, organization_id, current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(designId) as DesignRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    assertProjectAccess(access, row.organization_id, row.id);
    return row;
  }

  private designSystemResult(row: DesignSystemRow): DesignSystemResult {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private latestTokenVersion(designSystemId: string, tokenId: string): number {
    const row = this.database.sqlite.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM design_system_tokens WHERE design_system_id = ? AND token_id = ?",
    ).get(designSystemId, tokenId) as { version: number };
    return row.version;
  }

  private latestComponentVersion(designSystemId: string, componentId: string): number {
    const row = this.database.sqlite.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM component_definitions WHERE design_system_id = ? AND component_id = ?",
    ).get(designSystemId, componentId) as { version: number };
    return row.version;
  }

  private latestReleaseVersion(designSystemId: string): number {
    const row = this.database.sqlite.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM design_system_releases WHERE design_system_id = ?",
    ).get(designSystemId) as { version: number };
    return row.version;
  }

  private requireTokenRow(designSystemId: string, tokenId: string, version: number): TokenVersionRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM design_system_tokens WHERE design_system_id = ? AND token_id = ? AND version = ?",
    ).get(designSystemId, tokenId, version) as TokenVersionRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `Token version ${tokenId}@${version} was not found.`, 404);
    return row;
  }

  private requireLatestTokenRow(designSystemId: string, tokenId: string): TokenVersionRow {
    const row = this.database.sqlite.prepare(
      `SELECT * FROM design_system_tokens WHERE design_system_id = ? AND token_id = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(designSystemId, tokenId) as TokenVersionRow | undefined;
    if (!row) throw new DomainError("VALIDATION_FAILED", `Replacement token ${tokenId} does not exist in this design system.`, 422);
    return row;
  }

  private requireComponentRow(designSystemId: string, componentId: string, version: number): ComponentVersionRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM component_definitions WHERE design_system_id = ? AND component_id = ? AND version = ?",
    ).get(designSystemId, componentId, version) as ComponentVersionRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `Component version ${componentId}@${version} was not found.`, 404);
    return row;
  }

  private requireLatestComponentRow(designSystemId: string, componentId: string): ComponentVersionRow {
    const row = this.database.sqlite.prepare(
      `SELECT * FROM component_definitions WHERE design_system_id = ? AND component_id = ?
       ORDER BY version DESC LIMIT 1`,
    ).get(designSystemId, componentId) as ComponentVersionRow | undefined;
    if (!row) throw new DomainError("VALIDATION_FAILED", `Replacement component ${componentId} does not exist in this design system.`, 422);
    return row;
  }

  private tokenVersionResult(row: TokenVersionRow): DesignSystemTokenVersionResult {
    const canonical = canonicalEntity(DesignSystemTokenSchema, JSON.parse(row.token_json) as unknown, "Persisted design-system token");
    if (canonical.json !== row.token_json || canonical.value.id !== row.token_id) {
      throw new DomainError("INTERNAL_ERROR", "Persisted design-system token integrity check failed.", 500);
    }
    return {
      designSystemId: row.design_system_id,
      tokenId: row.token_id,
      version: row.version,
      status: row.status,
      token: canonical.value,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private componentVersionResult(row: ComponentVersionRow): ComponentDefinitionVersionResult {
    const canonical = canonicalEntity(ComponentDefinitionSchema, JSON.parse(row.definition_json) as unknown, "Persisted component definition");
    if (canonical.json !== row.definition_json
      || canonical.value.id !== row.component_id
      || canonical.value.version !== row.version
      || canonical.value.status !== row.status
      || (canonical.value.replacement_component_id ?? null) !== row.replacement_component_id) {
      throw new DomainError("INTERNAL_ERROR", "Persisted component-definition integrity check failed.", 500);
    }
    return {
      designSystemId: row.design_system_id,
      componentId: row.component_id,
      version: row.version,
      status: row.status,
      definition: canonical.value,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  private componentCatalogResult(
    row: ComponentVersionRow,
    latestByComponent: Map<string, ComponentVersionRow>,
    versionCount: number,
  ): ComponentDefinitionCatalogResult {
    const result = this.componentVersionResult(row);
    const isLatest = latestByComponent.get(row.component_id)?.version === row.version;
    const replacementRow = result.definition.replacement_component_id
      ? latestByComponent.get(result.definition.replacement_component_id)
      : undefined;
    const replacement = replacementRow
      ? this.componentVersionResult(replacementRow)
      : null;
    const diagnostics: DesignSystemDiagnostic[] = [];
    if (!isLatest) diagnostics.push({
      code: "COMPONENT_VERSION_IMMUTABLE",
      severity: "info",
      safety: "safe",
      message: `Component ${result.componentId}@${result.version} is an immutable historical version.`,
      entityKind: "component",
      entityId: result.componentId,
    });
    else if (result.status === "draft") diagnostics.push({
      code: "COMPONENT_DRAFT_REVIEW_REQUIRED",
      severity: "info",
      safety: "review_required",
      message: `Component ${result.componentId}@${result.version} is a draft and cannot enter a published release.`,
      entityKind: "component",
      entityId: result.componentId,
    });
    else if (result.status === "deprecated" && !result.definition.replacement_component_id) diagnostics.push({
      code: "DEPRECATED_COMPONENT_WITHOUT_REPLACEMENT",
      severity: "warning",
      safety: "review_required",
      message: `Deprecated component ${result.componentId} has no published replacement.`,
      entityKind: "component",
      entityId: result.componentId,
    });

    if (isLatest && result.definition.replacement_component_id && !replacementRow) diagnostics.push({
      code: "COMPONENT_REPLACEMENT_MISSING",
      severity: "error",
      safety: "blocked",
      message: `Replacement component ${result.definition.replacement_component_id} is unavailable.`,
      entityKind: "component",
      entityId: result.componentId,
    });
    else if (isLatest && replacement && replacement.status !== "published") diagnostics.push({
      code: "COMPONENT_REPLACEMENT_NOT_PUBLISHED",
      severity: "warning",
      safety: "review_required",
      message: `Replacement component ${replacement.componentId} is ${replacement.status}, not published.`,
      entityKind: "component",
      entityId: result.componentId,
    });

    return {
      ...result,
      isLatest,
      versionCount,
      replacement: replacement ? {
        componentId: replacement.componentId,
        version: replacement.version,
        status: replacement.status,
        name: replacement.definition.name,
      } : null,
      diagnostics: diagnostics.sort((left, right) => left.code.localeCompare(right.code)),
    };
  }

  private requireReleaseRow(access: AccessContext, releaseId: string): ReleaseRow {
    const row = this.database.sqlite.prepare(
      `SELECT release.* FROM design_system_releases release
       JOIN design_systems system ON system.id = release.design_system_id
       WHERE release.id = ? AND system.organization_id = ?`,
    ).get(releaseId, access.organizationId) as ReleaseRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design-system release not found.", 404);
    return row;
  }

  private releaseEnvelope(row: ReleaseRow): z.infer<typeof releaseEnvelopeSchema> {
    const canonical = canonicalEntity(releaseEnvelopeSchema, JSON.parse(row.release_json) as unknown, "Persisted design-system release", MAX_RELEASE_JSON_BYTES);
    const envelope = canonical.value;
    if (canonical.json !== row.release_json
      || envelope.release.id !== row.id
      || envelope.release.design_system_id !== row.design_system_id
      || envelope.release.version !== row.version
      || envelope.release.name !== row.name
      || envelope.release.status !== row.status
      || (envelope.release.published_at ?? null) !== row.published_at) {
      throw new DomainError("INTERNAL_ERROR", "Persisted design-system release integrity check failed.", 500);
    }
    if (!jsonEqual(envelope.release.token_ids, envelope.token_versions.map((item) => item.token_id))
      || !jsonEqual(envelope.release.component_versions, envelope.component_versions)) {
      throw new DomainError("INTERNAL_ERROR", "Persisted design-system release selection is inconsistent.", 500);
    }
    for (const item of envelope.token_versions) this.requireTokenRow(row.design_system_id, item.token_id, item.version);
    for (const item of envelope.component_versions) {
      this.requireComponentRow(row.design_system_id, item.component_definition_id, item.version);
    }
    return envelope;
  }

  private releaseResult(row: ReleaseRow): DesignSystemReleaseResult {
    const envelope = this.releaseEnvelope(row);
    return {
      id: row.id,
      designSystemId: row.design_system_id,
      version: row.version,
      name: row.name,
      status: row.status,
      tokenVersions: envelope.token_versions.map((item) => ({ tokenId: item.token_id, version: item.version })),
      componentVersions: envelope.component_versions.map((item) => ({
        componentDefinitionId: item.component_definition_id,
        version: item.version,
      })),
      diagnostics: envelope.diagnostics,
      createdBy: row.created_by,
      createdAt: row.created_at,
      publishedAt: row.published_at,
    };
  }

  private releaseDiagnostics(
    tokenRows: TokenVersionRow[],
    componentRows: ComponentVersionRow[],
    releaseStatus: DesignSystemReleaseStatus,
  ): DesignSystemDiagnostic[] {
    const diagnostics: DesignSystemDiagnostic[] = [];
    const tokens = Object.fromEntries(tokenRows.map((row) => {
      const result = this.tokenVersionResult(row);
      return [result.tokenId, result.token];
    }));
    const paths = new Map<string, string>();
    for (const row of tokenRows) {
      const result = this.tokenVersionResult(row);
      const prior = paths.get(result.token.path);
      if (prior) diagnostics.push({
        code: "TOKEN_PATH_DUPLICATE",
        severity: "error",
        safety: "blocked",
        message: `Tokens ${prior} and ${result.tokenId} use the same path ${result.token.path}.`,
        entityKind: "token",
        entityId: result.tokenId,
        path: result.token.path,
      });
      paths.set(result.token.path, result.tokenId);
      if (releaseStatus === "published" && row.status === "draft") diagnostics.push({
        code: "DRAFT_TOKEN_IN_PUBLISHED_RELEASE",
        severity: "error",
        safety: "blocked",
        message: `Token ${result.tokenId}@${result.version} is still draft.`,
        entityKind: "token",
        entityId: result.tokenId,
      });
      if (row.status === "deprecated") diagnostics.push({
        code: "DEPRECATED_TOKEN_SELECTED",
        severity: "warning",
        safety: "review_required",
        message: `Release includes deprecated token ${result.tokenId}.`,
        entityKind: "token",
        entityId: result.tokenId,
      });
      if (result.token.replacement_token_id && !tokens[result.token.replacement_token_id]) diagnostics.push({
        code: "TOKEN_REPLACEMENT_NOT_SELECTED",
        severity: "warning",
        safety: "review_required",
        message: `Replacement token ${result.token.replacement_token_id} is not selected in this release.`,
        entityKind: "token",
        entityId: result.tokenId,
      });
    }
    const modes = new Set<string>();
    for (const token of Object.values(tokens)) for (const mode of Object.keys(token.modes ?? {})) modes.add(mode);
    for (const token of Object.values(tokens)) {
      for (const mode of [undefined, ...modes] as Array<string | undefined>) {
        try {
          resolveDesignToken(tokens, token.id, mode);
        } catch (error) {
          diagnostics.push({
            code: "TOKEN_REFERENCE_INVALID",
            severity: "error",
            safety: "blocked",
            message: `${error instanceof Error ? error.message : String(error)}${mode ? ` in mode ${mode}` : ""}.`,
            entityKind: "token",
            entityId: token.id,
          });
        }
      }
    }

    const selectedComponents = new Set(componentRows.map((row) => row.component_id));
    for (const row of componentRows) {
      const result = this.componentVersionResult(row);
      if (releaseStatus === "published" && row.status === "draft") diagnostics.push({
        code: "DRAFT_COMPONENT_IN_PUBLISHED_RELEASE",
        severity: "error",
        safety: "blocked",
        message: `Component ${result.componentId}@${result.version} is still draft.`,
        entityKind: "component",
        entityId: result.componentId,
      });
      if (row.status === "deprecated") diagnostics.push({
        code: "DEPRECATED_COMPONENT_SELECTED",
        severity: "warning",
        safety: "review_required",
        message: `Release includes deprecated component ${result.componentId}.`,
        entityKind: "component",
        entityId: result.componentId,
      });
      if (result.definition.replacement_component_id && !selectedComponents.has(result.definition.replacement_component_id)) diagnostics.push({
        code: "COMPONENT_REPLACEMENT_NOT_SELECTED",
        severity: "warning",
        safety: "review_required",
        message: `Replacement component ${result.definition.replacement_component_id} is not selected in this release.`,
        entityKind: "component",
        entityId: result.componentId,
      });
    }
    return diagnostics.sort((left, right) => left.code.localeCompare(right.code)
      || (left.entityId ?? "").localeCompare(right.entityId ?? "")
      || left.message.localeCompare(right.message));
  }

  private projectPinRow(access: AccessContext, designId: string): ProjectPinRow | undefined {
    return this.database.sqlite.prepare(
      "SELECT * FROM project_design_system_pins WHERE design_id = ? AND organization_id = ?",
    ).get(designId, access.organizationId) as ProjectPinRow | undefined;
  }

  private requireProjectPinRow(access: AccessContext, designId: string): ProjectPinRow {
    const row = this.projectPinRow(access, designId);
    if (!row) throw new DomainError("NOT_FOUND", "The project has no pinned design-system release.", 404);
    return row;
  }

  private projectPinResult(row: ProjectPinRow): ProjectDesignSystemPinResult {
    return {
      designId: row.design_id,
      designSystemId: row.design_system_id,
      releaseId: row.release_id,
      releaseVersion: row.release_version,
      pinnedBy: row.pinned_by,
      pinnedAt: row.pinned_at,
    };
  }

  private buildUpgradePlan(design: DesignRow, currentRow: ReleaseRow, targetRow: ReleaseRow): {
    diagnostics: DesignSystemDiagnostic[];
    payloadJson: string;
    previewHash: string;
  } {
    const current = this.releaseEnvelope(currentRow);
    const target = this.releaseEnvelope(targetRow);
    const usage = this.designUsage(design);
    const diagnostics: DesignSystemDiagnostic[] = [];
    const currentTokens = new Map(current.token_versions.map((item) => [item.token_id, this.tokenVersionResult(
      this.requireTokenRow(currentRow.design_system_id, item.token_id, item.version),
    )]));
    const targetTokens = new Map(target.token_versions.map((item) => [item.token_id, this.tokenVersionResult(
      this.requireTokenRow(targetRow.design_system_id, item.token_id, item.version),
    )]));
    for (const [tokenId, previous] of currentTokens) {
      const next = targetTokens.get(tokenId);
      if (!next) {
        const used = usage.tokenIds.has(tokenId);
        diagnostics.push({
          code: used ? "USED_TOKEN_REMOVED" : "TOKEN_REMOVED",
          severity: used ? "error" : "warning",
          safety: used ? "blocked" : "review_required",
          message: `${used ? "Used t" : "T"}oken ${tokenId} is absent from the target release.`,
          entityKind: "token",
          entityId: tokenId,
        });
        continue;
      }
      if (previous.token.family !== next.token.family) diagnostics.push({
        code: "TOKEN_FAMILY_CHANGED",
        severity: "error",
        safety: "blocked",
        message: `Token ${tokenId} changes family from ${previous.token.family} to ${next.token.family}.`,
        entityKind: "token",
        entityId: tokenId,
      });
      else if (!jsonEqual({ value: previous.token.value, modes: previous.token.modes }, { value: next.token.value, modes: next.token.modes })) diagnostics.push({
        code: "TOKEN_VALUE_CHANGED",
        severity: "info",
        safety: "safe",
        message: `Token ${tokenId} changes resolved source values.`,
        entityKind: "token",
        entityId: tokenId,
      });
      if (next.status === "deprecated") diagnostics.push({
        code: "TARGET_TOKEN_DEPRECATED",
        severity: "warning",
        safety: "review_required",
        message: `Target release deprecates token ${tokenId}.`,
        entityKind: "token",
        entityId: tokenId,
      });
    }
    for (const tokenId of targetTokens.keys()) {
      if (!currentTokens.has(tokenId)) diagnostics.push({
        code: "TOKEN_ADDED",
        severity: "info",
        safety: "safe",
        message: `Target release adds token ${tokenId}.`,
        entityKind: "token",
        entityId: tokenId,
      });
    }

    const currentComponents = new Map(current.component_versions.map((item) => [item.component_definition_id, this.componentVersionResult(
      this.requireComponentRow(currentRow.design_system_id, item.component_definition_id, item.version),
    )]));
    const targetComponents = new Map(target.component_versions.map((item) => [item.component_definition_id, this.componentVersionResult(
      this.requireComponentRow(targetRow.design_system_id, item.component_definition_id, item.version),
    )]));
    for (const [componentId, previous] of currentComponents) {
      const next = targetComponents.get(componentId);
      if (!next) {
        const used = usage.componentIds.has(componentId);
        diagnostics.push({
          code: used ? "USED_COMPONENT_REMOVED" : "COMPONENT_REMOVED",
          severity: used ? "error" : "warning",
          safety: used ? "blocked" : "review_required",
          message: `${used ? "Used c" : "C"}omponent ${componentId} is absent from the target release.`,
          entityKind: "component",
          entityId: componentId,
        });
        continue;
      }
      if (previous.version !== next.version) {
        const previousProperties = new Map(previous.definition.properties_schema.map((property) => [property.key, property.type]));
        const nextProperties = new Map(next.definition.properties_schema.map((property) => [property.key, property.type]));
        const removedOrChanged = [...previousProperties].filter(([key, type]) => !nextProperties.has(key) || nextProperties.get(key) !== type);
        const previousStates = new Set(previous.definition.states.map((state) => state.key));
        const nextStates = new Set(next.definition.states.map((state) => state.key));
        const removedStates = [...previousStates].filter((state) => !nextStates.has(state));
        const previousSlots = new Set(previous.definition.slots.map((slot) => slot.key));
        const nextSlots = new Set(next.definition.slots.map((slot) => slot.key));
        const removedSlots = [...previousSlots].filter((slot) => !nextSlots.has(slot));
        if (removedOrChanged.length > 0 || removedStates.length > 0 || removedSlots.length > 0) diagnostics.push({
          code: "COMPONENT_CONTRACT_REVIEW_REQUIRED",
          severity: "warning",
          safety: "review_required",
          message: `Component ${componentId} removes or changes contract fields, states, or slots.`,
          entityKind: "component",
          entityId: componentId,
        });
        else diagnostics.push({
          code: "COMPONENT_VERSION_CHANGED",
          severity: "info",
          safety: "safe",
          message: `Component ${componentId} upgrades from version ${previous.version} to ${next.version}.`,
          entityKind: "component",
          entityId: componentId,
        });
      }
      if (next.status === "deprecated") diagnostics.push({
        code: "TARGET_COMPONENT_DEPRECATED",
        severity: "warning",
        safety: "review_required",
        message: `Target release deprecates component ${componentId}.`,
        entityKind: "component",
        entityId: componentId,
      });
    }
    for (const componentId of targetComponents.keys()) {
      if (!currentComponents.has(componentId)) diagnostics.push({
        code: "COMPONENT_ADDED",
        severity: "info",
        safety: "safe",
        message: `Target release adds component ${componentId}.`,
        entityKind: "component",
        entityId: componentId,
      });
    }
    if (diagnostics.length === 0) diagnostics.push({
      code: "RELEASE_CONTENT_UNCHANGED",
      severity: "info",
      safety: "safe",
      message: "The target release selects the same component and token content.",
      entityKind: "release",
      entityId: targetRow.id,
    });
    diagnostics.sort((left, right) => left.code.localeCompare(right.code)
      || (left.entityId ?? "").localeCompare(right.entityId ?? "")
      || left.message.localeCompare(right.message));
    const payload = upgradePreviewPayloadSchema.parse({
      format: "formaspec-design-system-upgrade-preview",
      format_version: 1,
      design_version: design.current_version,
      design_revision_id: design.current_revision_id,
      diagnostics,
    });
    const payloadJson = canonicalJson(payload);
    const previewHash = hashPayload({
      format: payload.format,
      formatVersion: payload.format_version,
      designId: design.id,
      designVersion: design.current_version,
      designRevisionId: design.current_revision_id,
      currentReleaseId: currentRow.id,
      targetReleaseId: targetRow.id,
      diagnostics,
    });
    return { diagnostics, payloadJson, previewHash };
  }

  private designUsage(design: DesignRow): { tokenIds: Set<string>; componentIds: Set<string> } {
    const revision = this.database.sqlite.prepare(
      "SELECT document_json, snapshot_hash FROM revisions WHERE id = ? AND design_id = ?",
    ).get(design.current_revision_id, design.id) as { document_json: string; snapshot_hash: string | null } | undefined;
    if (!revision) throw new DomainError("INTERNAL_ERROR", "The current design revision is unavailable.", 500);
    const raw = revision.snapshot_hash ? this.database.readSnapshot(revision.snapshot_hash) : revision.document_json;
    let document: unknown;
    try {
      document = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The current design revision is invalid.", 500, { cause: error });
    }
    const tokenIds = new Set<string>();
    const componentIds = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const object = value as Record<string, unknown>;
      if (typeof object.token_id === "string") tokenIds.add(object.token_id);
      if (typeof object.component_definition_id === "string") componentIds.add(object.component_definition_id);
      for (const child of Object.values(object)) visit(child);
    };
    visit(document);
    return { tokenIds, componentIds };
  }

  private expireUpgradePreviews(now: string): void {
    this.database.sqlite.prepare(
      `UPDATE design_system_upgrade_previews SET status = 'expired'
       WHERE expires_at <= ? AND status IN ('ready', 'blocked')`,
    ).run(now);
  }

  private requireUpgradePreviewRow(access: AccessContext, previewId: string, requireCreator = false): UpgradePreviewRow {
    if (!/^upgrade_[a-f0-9]{32}$/.test(previewId)) throw new DomainError("NOT_FOUND", "Design-system upgrade preview not found.", 404);
    const row = this.database.sqlite.prepare(
      `SELECT * FROM design_system_upgrade_previews
       WHERE id = ? AND organization_id = ?${requireCreator ? " AND created_by = ?" : ""}`,
    ).get(previewId, access.organizationId, ...(requireCreator ? [access.principalId] : [])) as UpgradePreviewRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design-system upgrade preview not found.", 404);
    const design = this.requireDesignRow(access, row.design_id);
    assertProjectAccess(access, row.organization_id, design.id);
    return row;
  }

  private previewPayload(row: UpgradePreviewRow): z.infer<typeof upgradePreviewPayloadSchema> {
    const canonical = canonicalEntity(
      upgradePreviewPayloadSchema,
      JSON.parse(row.diagnostics_json) as unknown,
      "Persisted design-system upgrade preview",
    );
    if (canonical.json !== row.diagnostics_json) {
      throw new DomainError("INTERNAL_ERROR", "Persisted design-system upgrade preview integrity check failed.", 500);
    }
    return canonical.value;
  }

  private upgradePreviewResult(row: UpgradePreviewRow): DesignSystemUpgradePreviewResult {
    const payload = this.previewPayload(row);
    if (!row.current_release_id) throw new DomainError("INTERNAL_ERROR", "Upgrade preview is missing its current release.", 500);
    const expectedHash = hashPayload({
      format: payload.format,
      formatVersion: payload.format_version,
      designId: row.design_id,
      designVersion: payload.design_version,
      designRevisionId: payload.design_revision_id,
      currentReleaseId: row.current_release_id,
      targetReleaseId: row.target_release_id,
      diagnostics: payload.diagnostics,
    });
    if (expectedHash !== row.preview_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted design-system upgrade preview hash is invalid.", 500);
    }
    return {
      id: row.id,
      designId: row.design_id,
      currentReleaseId: row.current_release_id,
      targetReleaseId: row.target_release_id,
      designVersion: payload.design_version,
      designRevisionId: payload.design_revision_id,
      diagnostics: payload.diagnostics,
      previewHash: row.preview_hash,
      status: row.status,
      canCommit: row.status === "ready" && !payload.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      committedAt: row.committed_at,
    };
  }

  private nowIso(): string {
    return this.#now().toISOString();
  }

  private nextIsoAfter(previous: string): string {
    const previousTime = new Date(previous).getTime();
    const currentTime = this.#now().getTime();
    if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
      throw new DomainError("INTERNAL_ERROR", "Design-system timestamps are invalid.", 500);
    }
    return new Date(Math.max(currentTime, previousTime + 1)).toISOString();
  }

  private numericVersionConflict(subject: string, expected: number, current: number): DomainError {
    return new DomainError("VERSION_CONFLICT", `Expected ${subject} version ${expected}, but the current version is ${current}.`, 409, {
      retryable: true,
      details: { subject, expectedVersion: expected, currentVersion: current },
    });
  }

  private versionConflict(subject: string, expected: string, current: string): DomainError {
    return new DomainError("VERSION_CONFLICT", `The ${subject} changed after it was read.`, 409, {
      retryable: true,
      details: { subject, expectedVersion: expected, currentVersion: current },
    });
  }
}
