import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-mcp-enterprise-output-"));
  temporaryDirectories.push(root);
  const built = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(built);
  await built.app.ready();
  return built;
}

async function callTool(
  built: DesignerApplication,
  name: keyof typeof MCP_TOOL_OUTPUT_SCHEMAS,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: `${name}-probe`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
  const body = response.json<{
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: unknown;
  }>();
  expect(body.error, `${name}: ${response.body}`).toBeUndefined();
  expect(body.result?.isError, `${name}: ${response.body}`).not.toBe(true);
  expect(body.result?.structuredContent, `${name}: ${response.body}`).toMatchObject({ ok: true });
  const output = body.result!.structuredContent!;
  expect(MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(output).success, name).toBe(true);
  return output;
}

describe("exact policy, product-specification, and design-system MCP results", () => {
  it("accepts real policy, specification preview/commit, release, pin, and upgrade lifecycles", async () => {
    const built = await application();
    await callTool(built, "organization_policy_read", { format: "json" });
    const yamlPolicy = await callTool(built, "organization_policy_read", { format: "yaml" });
    expect(yamlPolicy).toMatchObject({
      filename: "organization.formaspec.yaml",
      yaml: expect.stringContaining("formaspec-organization-config"),
    });

    const design = built.service.createDesign("local", {
      name: "Enterprise output contract",
      preset: "web",
      idempotencyKey: "enterprise-output-design-create",
    });
    const designId = design.document.id;
    const specificationPreview = await callTool(built, "product_spec_preview", {
      design_id: designId,
      base_version: 0,
      natural_language_brief: "Define the policy and design-system contract for this product.",
    });
    const preview = specificationPreview.preview as { id: string };
    await callTool(built, "product_spec_commit_preview", {
      design_id: designId,
      preview_id: preview.id,
      expected_base_version: 0,
      idempotency_key: "enterprise-output-spec-commit",
      message: "Commit exact product specification output",
    });
    await callTool(built, "product_spec_read", { design_id: designId, version: 1 });

    await callTool(built, "design_system_read", {});
    const system = built.designSystems.createDesignSystem("local", {
      name: "Enterprise output system",
      description: "A two-release system used to verify exact MCP output contracts.",
    });
    const release1 = built.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Enterprise output 1",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const release2 = built.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 1,
      name: "Enterprise output 2",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    built.designSystems.pinProject("local", {
      designId,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });

    const systems = await callTool(built, "design_system_list", {});
    expect(systems).toMatchObject({ designSystems: [expect.objectContaining({ id: system.id })] });
    await callTool(built, "design_system_release_read", { release_id: release2.id });
    await callTool(built, "design_system_project_pin_read", { design_id: designId });
    const upgrade = await callTool(built, "design_system_upgrade_preview", {
      design_id: designId,
      target_release_id: release2.id,
    });
    const upgradePreview = upgrade.preview as { id: string; previewHash: string };
    const committed = await callTool(built, "design_system_upgrade_commit", {
      preview_id: upgradePreview.id,
      expected_preview_hash: upgradePreview.previewHash,
    });
    expect(committed).toMatchObject({
      preview: { status: "committed", targetReleaseId: release2.id },
      pin: { releaseId: release2.id, releaseVersion: 2 },
    });
  });

  it("rejects nested unknown keys, shape drift, and collection/string limit violations", () => {
    const policy = {
      schemaVersion: 1,
      localization: {
        defaultLocale: "en-US",
        supportedLocales: ["en-US"],
        defaultDirection: "ltr",
        rtlLocales: [],
      },
      platforms: { enabled: ["web"], framePresets: ["desktop"] },
      designSystem: {
        requirePublishedRelease: false,
        allowDetachedTemplates: true,
        approvedFontFamilies: ["Inter"],
        approvedIconSets: ["Lucide"],
      },
      assets: {
        enabled: true,
        allowedMimeTypes: ["image/png"],
        maximumBytes: 1024,
        maximumPixels: 1,
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
        allowedAdapters: ["codex"],
        allowedScopes: ["organization_policy:read"],
        maximumExpirySeconds: 300,
        maximumActiveConnections: 1,
        requireProjectRestriction: false,
      },
      repositories: {
        enabled: true,
        allowedPlatforms: ["web"],
        requireExplicitGrant: true,
        readOnlyByDefault: true,
        maximumInventoryBytes: 1024,
        maximumInventoryEntities: 1,
        excludedPatterns: [],
      },
      backups: {
        enabled: true,
        requireVerifiedBeforeMigration: true,
        requireOffHostCopy: false,
        scheduleUtc: "0 2 * * *",
        retention: { daily: 7, weekly: 4, monthly: 12 },
      },
      identity: { roleMappings: [] },
      audit: { retentionDays: 30, includeReadEvents: false },
      exports: {
        allowPortableBundles: true,
        allowedTokenFormats: ["dtcg"],
        includePreviewsByDefault: false,
      },
    };
    const loadedPolicy = {
      organizationId: "organization_legacy",
      organizationName: "Legacy workspace",
      policy,
      policyHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      source: "stored",
      diagnostics: [],
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.organization_policy_read.safeParse({
      ok: true,
      organizationPolicy: {
        ...loadedPolicy,
        policy: { ...policy, localization: { ...policy.localization, unexpected: true } },
      },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.organization_policy_read.safeParse({
      ok: true,
      organizationPolicy: loadedPolicy,
      filename: "organization.formaspec.yaml",
      yaml: "x".repeat(524_289),
    }).success).toBe(false);

    const specificationResult = {
      designId: "document_outputschema0001",
      version: 1,
      specification: {
        id: "spec_outputschema0001",
        version: 1,
        natural_language_brief: "Exact specification",
      },
      specificationHash: "c".repeat(64),
      message: null,
      revisionId: null,
      actorId: "principal_local",
      createdAt: "2026-07-21T00:00:00.000Z",
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.product_spec_read.safeParse({
      ok: true,
      specification: {
        ...specificationResult,
        specification: { ...specificationResult.specification, unexpected: true },
      },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.product_spec_read.safeParse({
      ok: true,
      specification: { ...specificationResult, version: "1" },
    }).success).toBe(false);

    const designSystem = {
      id: "system_outputschema0001",
      name: "Output system",
      description: "Exact system",
      status: "active",
      createdBy: "principal_local",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_system_list.safeParse({
      ok: true,
      designSystems: [{ ...designSystem, unexpected: true }],
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_system_list.safeParse({
      ok: true,
      designSystems: Array.from({ length: 1_001 }, () => designSystem),
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_system_list.safeParse({
      ok: true,
      designSystems: [{ ...designSystem, description: "x".repeat(10_001) }],
    }).success).toBe(false);
  });
});
