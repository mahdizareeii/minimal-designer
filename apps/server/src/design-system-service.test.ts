import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DesignDocumentV2Schema,
  canonicalComponentSourceBundleBytes,
  canonicalComponentSourceBundleJson,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import {
  DesignSystemService,
  assessDesignSystemReleaseCompatibility,
  designSystemUsage,
} from "./design-system-service.js";
import { EventHub } from "./events.js";
import { canonicalJson } from "./ids.js";
import { DesignerService } from "./service.js";
import { createComponentSourceRevisionFixture } from "../test-fixtures/component-source.js";

const databases: DesignerDatabase[] = [];
const temporaryDirectories: string[] = [];

function setup(filename = ":memory:") {
  const database = new DesignerDatabase(filename);
  databases.push(database);
  const designer = new DesignerService(database, new EventHub(), 900);
  const design = designer.createDesign("local", {
    name: "Design-system project",
    preset: "web",
    idempotencyKey: "design-system-test-project",
  });
  let time = new Date("2026-07-19T10:00:00.000Z");
  const rawSystems = new DesignSystemService(database, {
    now: () => new Date(time),
    upgradePreviewTtlSeconds: 900,
    designerService: designer,
  });
  const componentSource = createComponentSourceRevisionFixture(
    database,
    designer,
    "local",
    [
      "node_primarybuttonroot001",
      "node_primarybuttonfocus001",
      "node_primarybuttonload0001",
      "node_actionbuttonroot0001",
    ],
    "design-system-service",
  );
  const systems = new Proxy(rawSystems, {
    get(target, property) {
      if (property === "createComponentVersion") {
        return ((actorId: string, designSystemId: string, input: Parameters<DesignSystemService["createComponentVersion"]>[2]) =>
          target.createComponentVersion(actorId, designSystemId, {
            ...input,
            source: input.source ?? componentSource,
          })) satisfies DesignSystemService["createComponentVersion"];
      }
      if (property === "transitionComponentLifecycle") {
        return ((actorId: string, designSystemId: string, componentId: string,
          input: Parameters<DesignSystemService["transitionComponentLifecycle"]>[3]) =>
          target.transitionComponentLifecycle(actorId, designSystemId, componentId, {
            ...input,
            source: input.source ?? componentSource,
          })) satisfies DesignSystemService["transitionComponentLifecycle"];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database,
    designer,
    design,
    systems,
    rawSystems,
    componentSource,
    setTime(value: string) { time = new Date(value); },
  };
}

function token(value: string | number, family: "color" | "spacing" = "color") {
  return {
    id: "token_primaryaction0001",
    path: "action.primary.background",
    name: "Primary action background",
    family,
    layer: "semantic",
    value,
    deprecated: false,
  };
}

function component(version: number, options: {
  removeLabel?: boolean;
  id?: string;
  key?: string;
  name?: string;
  rootNodeId?: string;
  status?: "draft" | "published" | "deprecated";
} = {}) {
  const rootNodeId = options.rootNodeId ?? "node_primarybuttonroot001";
  return {
    id: options.id ?? "component_primarybutton0001",
    key: options.key ?? "button.primary",
    name: options.name ?? "Primary button",
    version,
    status: options.status ?? "published" as const,
    root_node_id: rootNodeId,
    properties_schema: options.removeLabel ? [] : [{
      key: "label",
      label: "Label",
      required: true,
      type: "text" as const,
      default: "Continue",
    }],
    slots: [],
    states: [{ key: "default" as const, name: "Default", node_id: rootNodeId }],
    allowed_overrides: {
      allow_text: true,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: ["color" as const],
      allowed_style_paths: ["fill" as const],
    },
    platform_mappings: [],
    documentation: {
      summary: "Primary product action.",
      usage: [],
      accessibility: [],
      do_list: [],
      dont_list: [],
    },
  };
}

function createPublishedRelease(
  systems: DesignSystemService,
  designSystemId: string,
  releaseVersion: number,
  tokenVersion: number,
  componentVersion: number,
) {
  return systems.createRelease("local", designSystemId, {
    expectedLatestVersion: releaseVersion - 1,
    name: `Release ${releaseVersion}`,
    status: "published",
    tokenVersions: [{ tokenId: "token_primaryaction0001", version: tokenVersion }],
    componentVersions: [{ componentDefinitionId: "component_primarybutton0001", version: componentVersion }],
  });
}

function seedVerifiedMigrationBackup(database: DesignerDatabase, id: string, createdAt: string): void {
  const manifest = {
    format: "formaspec-backup",
    formatVersion: 2,
    createdAt,
    databaseSchemaVersion: database.schemaVersion(),
  };
  const verification = {
    valid: true,
    manifest,
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'design-system-v2-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(id, "a".repeat(64), JSON.stringify(manifest), createdAt, createdAt, JSON.stringify(verification), createdAt);
}

function persistedState(database: DesignerDatabase, designId: string) {
  return {
    revisions: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
    ).get(designId) as { count: number }).count,
    snapshots: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM snapshots",
    ).get() as { count: number }).count,
    outboxEvents: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox",
    ).get() as { count: number }).count,
    auditEvents: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events",
    ).get() as { count: number }).count,
    idempotencyRows: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency",
    ).get() as { count: number }).count,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("persisted design-system service", () => {
  it("generates a stable opaque component ID for a new source-backed draft when the client omits it", () => {
    const { systems } = setup();
    const system = systems.createDesignSystem("local", { name: "Server generated component IDs" });
    const { id: _clientId, ...definition } = component(1);
    const created = systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition,
    });
    expect(created.componentId).toMatch(/^component_[a-f0-9]{32}$/);
    expect(created.definition.id).toBe(created.componentId);
    expect(created.source.publishable).toBe(true);
  });

  it("captures an authorized exact V2 component source and persists canonical bytes with a verified hash", () => {
    const { database, rawSystems, componentSource } = setup();
    const system = rawSystems.createDesignSystem("local", { name: "Source-backed system" });
    const created = rawSystems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
      source: componentSource,
    });
    expect(created.source).toMatchObject({
      kind: "verified",
      publishable: true,
      nodeCount: 1,
      prototypeLinkCount: 0,
    });
    const full = rawSystems.readComponentSource("local", system.id, created.componentId, created.version);
    expect(full.source).not.toBeNull();
    expect(full.publishable).toBe(true);
    const expectedJson = canonicalComponentSourceBundleJson(full.source);
    const expectedHash = createHash("sha256")
      .update(canonicalComponentSourceBundleBytes(full.source))
      .digest("hex");
    expect(full.sourceHash).toBe(expectedHash);
    const stored = database.sqlite.prepare(
      `SELECT source_json, source_hash FROM component_definitions
       WHERE design_system_id = ? AND component_id = ? AND version = 1`,
    ).get(system.id, created.componentId) as { source_json: string; source_hash: string };
    expect(stored).toEqual({ source_json: expectedJson, source_hash: expectedHash });
    expect(() => rawSystems.transitionComponentLifecycle("local", system.id, created.componentId, {
      expectedLatestVersion: 1,
      targetStatus: "deprecated",
    })).toThrow(expect.objectContaining({
      code: "VALIDATION_FAILED",
      details: { diagnostics: [expect.objectContaining({ code: "COMPONENT_SOURCE_REQUIRED" })] },
    }));

    const release = rawSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Verified source release",
      status: "published",
      tokenVersions: [],
      componentVersions: [{ componentDefinitionId: created.componentId, version: created.version }],
    });
    expect(release.componentVersions).toEqual([
      { componentDefinitionId: created.componentId, version: created.version },
    ]);
    expect(() => database.sqlite.prepare(
      `UPDATE component_definitions SET source_hash = ?
       WHERE design_system_id = ? AND component_id = ? AND version = 1`,
    ).run("f".repeat(64), system.id, created.componentId)).toThrow(/immutable/);
    database.sqlite.exec("DROP TRIGGER component_definitions_immutable_update");
    database.sqlite.prepare(
      `UPDATE component_definitions SET source_hash = ?
       WHERE design_system_id = ? AND component_id = ? AND version = 1`,
    ).run("f".repeat(64), system.id, created.componentId);
    expect(() => rawSystems.readComponentSource("local", system.id, created.componentId, 1))
      .toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
    expect(() => rawSystems.readRelease("local", release.id))
      .toThrow(expect.objectContaining({ code: "INTERNAL_ERROR" }));
  });

  it("requires a V2 source and denies mismatched-revision and cross-organization capture references", () => {
    const { database, design, rawSystems, componentSource } = setup();
    const system = rawSystems.createDesignSystem("local", { name: "Strict source system" });
    const definition = component(1, { status: "draft" });
    expect(() => rawSystems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition,
    })).toThrow(expect.objectContaining({
      code: "VALIDATION_FAILED",
      details: { diagnostics: [expect.objectContaining({ code: "COMPONENT_SOURCE_REQUIRED" })] },
    }));
    expect(() => rawSystems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition,
      source: { designId: design.design.id, revisionId: design.revision.id },
    })).toThrow(expect.objectContaining({
      code: "VALIDATION_FAILED",
      details: { diagnostics: [expect.objectContaining({ code: "COMPONENT_SOURCE_INVALID" })] },
    }));
    expect(() => rawSystems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition,
      source: { designId: componentSource.designId, revisionId: design.revision.id },
    })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    const now = "2026-07-19T10:00:00.000Z";
    database.sqlite.prepare(
      `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
       VALUES ('organization_component_source_foreign', 'Foreign source organization', '{}', ?, ?)`,
    ).run(now, now);
    database.sqlite.prepare(
      "UPDATE designs SET organization_id = 'organization_component_source_foreign' WHERE id = ?",
    ).run(componentSource.designId);
    expect(() => rawSystems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition,
      source: componentSource,
    })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM component_definitions WHERE design_system_id = ?",
    ).get(system.id)).toEqual({ count: 0 });
  });

  it("keeps legacy null-source components readable but rejects them from every new release", () => {
    const { database, rawSystems } = setup();
    const system = rawSystems.createDesignSystem("local", { name: "Legacy component system" });
    const definition = component(1);
    database.sqlite.prepare(
      `INSERT INTO component_definitions
       (design_system_id, component_id, version, status, definition_json, replacement_component_id,
        source_json, source_hash, created_by, created_at)
       VALUES (?, ?, 1, 'published', ?, NULL, NULL, NULL, 'principal_local', '2026-07-19T10:00:00.000Z')`,
    ).run(system.id, definition.id, canonicalJson(definition));

    const catalog = rawSystems.listComponentDefinitions("local", system.id);
    expect(catalog).toEqual([
      expect.objectContaining({
        componentId: definition.id,
        source: { kind: "legacy_null", hash: null, nodeCount: 0, prototypeLinkCount: 0, publishable: false },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "COMPONENT_SOURCE_LEGACY_UNPUBLISHABLE", safety: "blocked" }),
        ]),
      }),
    ]);
    expect(rawSystems.readComponentSource("local", system.id, definition.id, 1)).toMatchObject({
      sourceHash: null,
      source: null,
      publishable: false,
    });
    expect(() => rawSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Legacy draft release",
      status: "draft",
      tokenVersions: [],
      componentVersions: [{ componentDefinitionId: definition.id, version: 1 }],
    })).toThrow(expect.objectContaining({
      code: "VALIDATION_FAILED",
      details: { diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "COMPONENT_SOURCE_LEGACY_UNPUBLISHABLE" }),
      ]) },
    }));
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM design_system_releases WHERE design_system_id = ?",
    ).get(system.id)).toEqual({ count: 0 });
  });

  it("creates mutable system metadata and append-only token, component, and release versions", () => {
    const { database, systems, setTime } = setup();
    const system = systems.createDesignSystem("local", {
      name: "Company Product System",
      description: "Shared product primitives.",
    });
    expect(system.id).toMatch(/^system_[a-f0-9]{32}$/);
    expect(system.status).toBe("active");

    setTime("2026-07-19T10:01:00.000Z");
    const renamed = systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      name: "Company Product Foundation",
    });
    expect(renamed.name).toBe("Company Product Foundation");
    expect(() => systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      description: "stale write",
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    const tokenV1 = systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    const componentV1 = systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, tokenV1.version, componentV1.version);
    expect(release).toMatchObject({
      version: 1,
      status: "published",
      tokenVersions: [{ tokenId: tokenV1.tokenId, version: 1 }],
      componentVersions: [{ componentDefinitionId: componentV1.componentId, version: 1 }],
    });
    expect(release.publishedAt).not.toBeNull();

    expect(() => database.sqlite.prepare(
      "UPDATE design_system_tokens SET status = 'deprecated' WHERE design_system_id = ? AND token_id = ? AND version = 1",
    ).run(system.id, tokenV1.tokenId)).toThrow("design system tokens are immutable");
    expect(() => database.sqlite.prepare(
      "UPDATE component_definitions SET status = 'deprecated' WHERE design_system_id = ? AND component_id = ? AND version = 1",
    ).run(system.id, componentV1.componentId)).toThrow("component definitions are immutable");
    expect(() => database.sqlite.prepare(
      "UPDATE design_system_releases SET name = 'changed' WHERE id = ?",
    ).run(release.id)).toThrow("design system releases are immutable");

    const actions = database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'design_system.%' ORDER BY id",
    ).all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual([
      "design_system.create",
      "design_system.update",
      "design_system.token_version.create",
      "design_system.component_version.create",
      "design_system.release.create",
    ]);
  });

  it("pins published releases and atomically commits a ready upgrade preview without rewriting a V1 head", () => {
    const { database, designer, systems, design, setTime } = setup();
    const originalHead = designer.getDesign("local", design.design.id);
    const system = systems.createDesignSystem("local", { name: "Checkout System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    const initialPin = systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    expect(initialPin.releaseVersion).toBe(1);
    expect(designer.getDesign("local", design.design.id)).toEqual(originalHead);
    expect(persistedState(database, design.design.id).revisions).toBe(1);

    expect(() => systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));
    expect(persistedState(database, design.design.id).revisions).toBe(1);

    setTime("2026-07-19T10:05:00.000Z");
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(preview.status).toBe("ready");
    expect(preview.canCommit).toBe(true);
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "COMPONENT_VERSION_CHANGED",
      "TOKEN_VALUE_CHANGED",
    ]);

    const committed = systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    });
    expect(committed.preview.status).toBe("committed");
    expect(committed.pin).toMatchObject({ releaseId: release2.id, releaseVersion: 2 });
    expect(designer.getDesign("local", design.design.id)).toEqual(originalHead);
    expect(persistedState(database, design.design.id).revisions).toBe(1);
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_ALREADY_COMMITTED" }));
  });

  it("creates immutable V2 head revisions when a project pin is assigned or upgraded", () => {
    const { database, designer, systems, design } = setup();
    const backupId = "backup_designsystemv2gate01";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    const migrated = designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-migration-0001",
    });
    expect(migrated.result.schemaVersion).toBe(2);

    const system = systems.createDesignSystem("local", { name: "V2 synchronized system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });

    const pinned = designer.getDesign("local", design.design.id);
    expect(pinned.revision.version).toBe(3);
    if (pinned.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(pinned.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release1.id,
      release_version: 1,
    });

    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(preview.designVersion).toBe(3);
    expect(preview.baseRevisionId).toBe(pinned.revision.id);
    expect(preview.baseSnapshotHash).toBe(pinned.revision.snapshotHash);
    expect(preview.resultSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    const previewDocument = DesignDocumentV2Schema.parse(JSON.parse(
      database.readSnapshot(preview.resultSnapshotHash!),
    ));
    expect(previewDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release2.id,
      release_version: 2,
    });
    expect(previewDocument.component_definitions.component_primarybutton0001?.version).toBe(2);
    expect(Object.values(previewDocument.nodes).some((node) =>
      node.archived && node.metadata.formaspec_component_source !== undefined)).toBe(true);
    const committed = systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    });
    expect(committed.pin.releaseId).toBe(release2.id);

    const upgraded = designer.getDesign("local", design.design.id);
    expect(upgraded.revision.version).toBe(4);
    expect(upgraded.revision.snapshotHash).toBe(preview.resultSnapshotHash);
    expect(upgraded.canonicalDocument).toEqual(previewDocument);
    if (upgraded.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(upgraded.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release2.id,
      release_version: 2,
    });
    expect(database.sqlite.prepare(
      "SELECT version, message FROM revisions WHERE design_id = ? ORDER BY version",
    ).all(design.design.id)).toEqual([
      { version: 1, message: "Create design" },
      { version: 2, message: "System migration from document schema V1 to V2" },
      { version: 3, message: "Pin design system release 1" },
      { version: 4, message: "Upgrade design system to release 2" },
    ]);
  });

  it("preserves an existing V1 project pin in the single V2 migration revision", () => {
    const { database, designer, systems, design } = setup();
    const system = systems.createDesignSystem("local", { name: "Pre-migration pin system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    expect(designer.getDesign("local", design.design.id).revision.version).toBe(1);

    const backupId = "backup_designsystempreserve1";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    const migrated = designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-preserve-pin-0001",
    });

    expect(migrated.result.revision.version).toBe(2);
    if (migrated.result.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(migrated.result.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release.id,
      release_version: 1,
    });
    expect(systems.readProjectPin("local", design.design.id)).toMatchObject({
      designSystemId: system.id,
      releaseId: release.id,
      releaseVersion: 1,
    });
    expect(database.sqlite.prepare(
      "SELECT version, message FROM revisions WHERE design_id = ? ORDER BY version",
    ).all(design.design.id)).toEqual([
      { version: 1, message: "Create design" },
      { version: 2, message: "System migration from document schema V1 to V2" },
    ]);
  });

  it("requires a verified migration backup created after the latest V1 project-pin change", () => {
    const { database, designer, systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Migration watermark system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, 1, 1);
    const staleBackupId = "backup_beforev1pinchange01";
    seedVerifiedMigrationBackup(database, staleBackupId, design.design.updatedAt);
    setTime(new Date(Date.parse(design.design.updatedAt) + 1_000).toISOString());
    const pin = systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    expect(Date.parse(pin.pinnedAt)).toBeGreaterThan(Date.parse(design.design.updatedAt));
    expect(designer.getDesign("local", design.design.id).revision.version).toBe(1);
    const beforeRejectedMigration = persistedState(database, design.design.id);

    expect(() => designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId: staleBackupId,
      idempotencyKey: "design-system-stale-pin-backup-0001",
    })).toThrow(expect.objectContaining({
      code: "VALIDATION_FAILED",
      details: expect.objectContaining({
        backupCreatedAt: design.design.updatedAt,
        projectPinUpdatedAt: pin.pinnedAt,
        sourceWatermark: pin.pinnedAt,
      }),
    }));
    expect(persistedState(database, design.design.id)).toEqual(beforeRejectedMigration);

    const freshBackupId = "backup_afterv1pinchange001";
    seedVerifiedMigrationBackup(database, freshBackupId, pin.pinnedAt);
    const migrated = designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId: freshBackupId,
      idempotencyKey: "design-system-fresh-pin-backup-0001",
    });
    expect(migrated.migrated).toBe(true);
    if (migrated.result.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(migrated.result.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release.id,
      release_version: 1,
    });
  });

  it("rolls back an initial V2 pin, synchronized revision, snapshot, and outbox event together", () => {
    const { database, designer, systems, design } = setup();
    const backupId = "backup_designsystemrollback01";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-rollback-migration-0001",
    });
    const system = systems.createDesignSystem("local", { name: "Atomic pin system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, 1, 1);
    const before = persistedState(database, design.design.id);
    const beforeHead = designer.getDesign("local", design.design.id);
    database.sqlite.exec(`
      CREATE TRIGGER fail_project_pin_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'design_system.project_pin'
      BEGIN
        SELECT RAISE(ABORT, 'forced pin audit failure');
      END;
    `);

    expect(() => systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    })).toThrow("forced pin audit failure");

    expect(() => systems.readProjectPin("local", design.design.id)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(designer.getDesign("local", design.design.id)).toEqual(beforeHead);
    expect(persistedState(database, design.design.id)).toEqual(before);
  });

  it("rolls back a V2 upgrade pin, revision, preview status, snapshot, and outbox event together", () => {
    const { database, designer, systems, design } = setup();
    const backupId = "backup_designsystemrollback02";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-rollback-migration-0002",
    });
    const system = systems.createDesignSystem("local", { name: "Atomic upgrade system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    const before = persistedState(database, design.design.id);
    const beforeHead = designer.getDesign("local", design.design.id);
    database.sqlite.exec(`
      CREATE TRIGGER fail_project_upgrade_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'design_system.upgrade_commit'
      BEGIN
        SELECT RAISE(ABORT, 'forced upgrade audit failure');
      END;
    `);

    expect(() => systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    })).toThrow("forced upgrade audit failure");

    expect(systems.readProjectPin("local", design.design.id).releaseId).toBe(release1.id);
    expect(systems.readUpgradePreview("local", preview.id)).toMatchObject({
      status: "ready",
      committedAt: null,
    });
    expect(designer.getDesign("local", design.design.id)).toEqual(beforeHead);
    expect(persistedState(database, design.design.id)).toEqual(before);
  });

  it("rejects an upgrade preview after V2 document-head drift without changing the pin", () => {
    const { database, designer, systems, design } = setup();
    const backupId = "backup_designsystemstale001";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-stale-migration-0001",
    });
    const system = systems.createDesignSystem("local", { name: "Stale preview system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(preview.designVersion).toBe(3);
    const drift = designer.restoreRevision("local", design.design.id, {
      targetVersion: 3,
      expectedBaseVersion: 3,
      idempotencyKey: "design-system-v2-stale-drift-0001",
    });
    expect(drift.revision.version).toBe(4);
    const before = persistedState(database, design.design.id);

    expect(() => systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    expect(systems.readProjectPin("local", design.design.id).releaseId).toBe(release1.id);
    expect(systems.readUpgradePreview("local", preview.id).status).toBe("ready");
    expect(designer.getDesign("local", design.design.id).revision.version).toBe(4);
    expect(persistedState(database, design.design.id)).toEqual(before);
  });

  it("ignores metadata and migration-quarantine lookalike IDs during upgrades and same-pin restores", () => {
    const { database, designer, systems, design } = setup();
    const frameId = design.document.pages[0]!.children[0]!;
    const backupId = "backup_metadatausagegate01";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-metadata-usage-migration-0001",
    });
    const system = systems.createDesignSystem("local", { name: "Typed usage system" });
    const release1 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Release 1",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    const fakeTokenId = "token_metadataonly0001";
    const fakeComponentId = "component_metadataonly001";
    const metadataRevision = designer.applyRevision("local", design.design.id, {
      baseVersion: 3,
      operations: [
        {
          type: "set_metadata",
          target: { kind: "document" },
          metadata: {
            token_id: fakeTokenId,
            component_definition_id: fakeComponentId,
            prompt_payload: {
              token_id: fakeTokenId,
              component_definition_id: fakeComponentId,
            },
          },
          mode: "merge",
        },
        {
          type: "set_metadata",
          target: { kind: "node", id: frameId },
          metadata: {
            token_id: fakeTokenId,
            component_definition_id: fakeComponentId,
          },
          mode: "merge",
        },
      ],
      idempotencyKey: "design-system-metadata-lookalikes-0001",
      message: "Store metadata lookalikes",
    });
    if (metadataRevision.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    const migration = metadataRevision.canonicalDocument.migration;
    if (!migration) throw new Error("Expected migration provenance.");
    const quarantined = DesignDocumentV2Schema.parse({
      ...metadataRevision.canonicalDocument,
      migration: {
        ...migration,
        legacy_component_overrides: {
          ...migration.legacy_component_overrides,
          [frameId]: {
            token_id: fakeTokenId,
            component_definition_id: fakeComponentId,
          },
        },
        diagnostics: [
          ...migration.diagnostics,
          {
            code: "LEGACY_REFERENCE_LOOKALIKE",
            severity: "warning",
            message: "Quarantined metadata is not a live design-system reference.",
            node_id: frameId,
            token_id: fakeTokenId,
          },
        ],
      },
    });
    const quarantinedUsage = designSystemUsage(quarantined);
    expect([...quarantinedUsage.tokenIds]).not.toContain(fakeTokenId);
    expect([...quarantinedUsage.componentIds]).not.toContain(fakeComponentId);

    const release2 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 1,
      name: "Release 2",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const frame = metadataRevision.canonicalDocument.nodes[frameId];
    if (!frame) throw new Error("Expected frame node.");
    const malformedTypedTarget = DesignDocumentV2Schema.parse({
      ...metadataRevision.canonicalDocument,
      nodes: {
        ...metadataRevision.canonicalDocument.nodes,
        [frameId]: {
          ...frame,
          style: { ...frame.style, fill: { token_id: fakeTokenId } },
        },
      },
    });
    expect(assessDesignSystemReleaseCompatibility(database, {
      organizationId: resolveAccess(database.sqlite, "local").organizationId,
      sourceReleaseId: release1.id,
      targetReleaseId: release2.id,
      document: malformedTypedTarget,
    }).diagnostics).toContainEqual(expect.objectContaining({
      code: "USED_TOKEN_REMOVED",
      safety: "blocked",
      entityId: fakeTokenId,
    }));
    const upgrade = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(upgrade.status).toBe("ready");
    expect(upgrade.diagnostics).toEqual([expect.objectContaining({
      code: "RELEASE_CONTENT_UNCHANGED",
      safety: "safe",
    })]);
    systems.commitProjectUpgrade("local", {
      previewId: upgrade.id,
      expectedPreviewHash: upgrade.previewHash,
    });
    const changed = designer.applyRevision("local", design.design.id, {
      baseVersion: 5,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "After metadata target" } }],
      idempotencyKey: "design-system-metadata-after-target-0001",
      message: "Create a later same-pin revision",
    });
    expect(changed.revision.version).toBe(6);
    const restored = designer.restoreRevision("local", design.design.id, {
      targetVersion: 5,
      expectedBaseVersion: 6,
      idempotencyKey: "design-system-metadata-same-pin-restore-0001",
    });
    expect(restored.restore.designSystem.status).toBe("active_pin_unchanged");
    expect(restored.canonicalDocument.metadata).toMatchObject({
      token_id: fakeTokenId,
      component_definition_id: fakeComponentId,
    });
    expect(restored.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "USED_TOKEN_REMOVED",
    }));
    expect(restored.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "USED_COMPONENT_REMOVED",
    }));
  });

  it("restores historical V2 content while atomically preserving the active project pin", () => {
    const { database, designer, systems, design } = setup();
    const frameId = design.document.pages[0]!.children[0]!;
    const backupId = "backup_designsystemrestore01";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-restore-migration-0001",
    });
    const system = systems.createDesignSystem("local", { name: "Restore consistency system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    const release1Content = designer.applyRevision("bob", design.design.id, {
      baseVersion: 3,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Release 1 content" } }],
      idempotencyKey: "design-system-v2-release1-content-0001",
      message: "Release 1 content",
    });
    expect(release1Content.revision.version).toBe(4);
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const preview = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(preview.designVersion).toBe(4);
    systems.commitProjectUpgrade("local", {
      previewId: preview.id,
      expectedPreviewHash: preview.previewHash,
    });
    const release2Content = designer.applyRevision("bob", design.design.id, {
      baseVersion: 5,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Release 2 content" } }],
      idempotencyKey: "design-system-v2-release2-content-0001",
      message: "Release 2 content",
    });
    expect(release2Content.revision.version).toBe(6);

    const input = {
      targetVersion: 4,
      expectedBaseVersion: 6,
      idempotencyKey: "design-system-v2-cross-pin-restore-0001",
    };
    const before = persistedState(database, design.design.id);
    database.sqlite.exec(`
      CREATE TRIGGER fail_cross_pin_restore_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'design.revision.restore'
      BEGIN
        SELECT RAISE(ABORT, 'forced restore audit failure');
      END;
    `);
    expect(() => designer.restoreRevision("bob", design.design.id, input)).toThrow("forced restore audit failure");
    expect(persistedState(database, design.design.id)).toEqual(before);
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE actor_id = ? AND scope = ? AND key = ?",
    ).get("bob", `design:${design.design.id}:restore`, input.idempotencyKey)).toEqual({ count: 0 });
    database.sqlite.exec("DROP TRIGGER fail_cross_pin_restore_audit");

    const restored = designer.restoreRevision("bob", design.design.id, input);
    expect(restored.revision.version).toBe(7);
    expect(restored.canonicalDocument.nodes[frameId]?.name).toBe("Release 1 content");
    if (restored.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(restored.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release2.id,
      release_version: 2,
    });
    expect(restored.restore).toMatchObject({
      targetVersion: 4,
      targetSchemaVersion: 2,
      designSystem: {
        status: "active_pin_preserved",
        pinSource: "project_design_system_pins",
        active: {
          designSystemId: system.id,
          releaseId: release2.id,
          releaseVersion: 2,
        },
        historical: {
          designSystemId: system.id,
          releaseId: release1.id,
          releaseVersion: 1,
        },
      },
    });
    expect(restored.diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "RESTORE_DESIGN_SYSTEM_PIN_PRESERVED",
      path: "design_system",
      target_version: 4,
      pin_source: "project_design_system_pins",
      active_design_system_id: system.id,
      active_release_id: release2.id,
      active_release_version: 2,
      historical_design_system_id: system.id,
      historical_release_id: release1.id,
      historical_release_version: 1,
    }));
    expect(systems.readProjectPin("local", design.design.id)).toMatchObject({
      releaseId: release2.id,
      releaseVersion: 2,
    });
    const persistedRestore = database.sqlite.prepare(
      "SELECT message, operations_json FROM revisions WHERE id = ?",
    ).get(restored.revision.id) as { message: string; operations_json: string };
    expect(persistedRestore.message).toContain('"kind":"formaspec-revision-restore"');
    expect(persistedRestore.message).toContain(`"targetRevisionId":"${restored.restore.targetRevisionId}"`);
    expect(persistedRestore.message).toContain(`"releaseId":"${release1.id}"`);
    expect(persistedRestore.message).toContain(`"releaseId":"${release2.id}"`);
    expect(JSON.parse(persistedRestore.operations_json)).toEqual([]);
    const restoreAudit = database.sqlite.prepare(
      "SELECT target_id, details_json FROM audit_events WHERE action = 'design.revision.restore' ORDER BY id DESC LIMIT 1",
    ).get() as { target_id: string; details_json: string };
    expect(restoreAudit.target_id).toBe(restored.revision.id);
    expect(JSON.parse(restoreAudit.details_json)).toMatchObject({
      designId: design.design.id,
      revisionId: restored.revision.id,
      targetVersion: 4,
      targetRevisionId: restored.restore.targetRevisionId,
      designSystem: {
        status: "active_pin_preserved",
        active: { releaseId: release2.id },
        historical: { releaseId: release1.id },
      },
    });
    const afterRestore = persistedState(database, design.design.id);
    const replay = designer.restoreRevision("bob", design.design.id, input);
    expect(replay).toEqual(restored);
    expect(persistedState(database, design.design.id)).toEqual(afterRestore);

    const samePinRestore = designer.restoreRevision("bob", design.design.id, {
      targetVersion: 6,
      expectedBaseVersion: 7,
      idempotencyKey: "design-system-v2-same-pin-restore-0001",
    });
    expect(samePinRestore.revision.version).toBe(8);
    expect(samePinRestore.canonicalDocument.nodes[frameId]?.name).toBe("Release 2 content");
    if (samePinRestore.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(samePinRestore.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release2.id,
      release_version: 2,
    });
    expect(samePinRestore.restore.designSystem.status).toBe("active_pin_unchanged");
    expect(samePinRestore.diagnostics).not.toContainEqual(expect.objectContaining({
      code: "RESTORE_DESIGN_SYSTEM_PIN_PRESERVED",
    }));
    expect(systems.readProjectPin("local", design.design.id)).toMatchObject({
      releaseId: release2.id,
      releaseVersion: 2,
    });
  });

  it("rejects a historical V2 restore when the preserved active release omits a token used by the target", () => {
    const { database, designer, systems, design } = setup();
    const frameId = design.document.pages[0]!.children[0]!;
    const tokenId = "token_primaryaction0001";
    const tokenContent = designer.applyRevision("local", design.design.id, {
      baseVersion: 1,
      operations: [
        {
          type: "upsert_token",
          token: {
            id: tokenId,
            name: "Primary action background",
            path: "action.primary.background",
            kind: "color",
            value: "#2457e6",
            archived: false,
            metadata: {},
          },
        },
        {
          type: "update_node",
          node_id: frameId,
          patch: { style: { fill: { token_id: tokenId } } },
        },
      ],
      idempotencyKey: "design-system-restore-token-reference-0001",
      message: "Use release token",
    });
    expect(tokenContent.revision.version).toBe(2);

    const system = systems.createDesignSystem("local", { name: "Restore compatibility system" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    const release1 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Release 1",
      status: "published",
      tokenVersions: [{ tokenId, version: 1 }],
      componentVersions: [],
    });
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    const backupId = "backup_restorecompatibility01";
    const pinnedAt = systems.readProjectPin("local", design.design.id).pinnedAt;
    const designUpdatedAt = designer.getDesign("local", design.design.id).design.updatedAt;
    seedVerifiedMigrationBackup(database, backupId, new Date(Math.max(
      Date.parse(pinnedAt),
      Date.parse(designUpdatedAt),
    )).toISOString());
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 2,
      backupId,
      idempotencyKey: "design-system-restore-compatibility-migration-0001",
    });

    const cleared = designer.applyRevision("local", design.design.id, {
      baseVersion: 3,
      operations: [{ type: "update_node", node_id: frameId, patch: { clear_style: ["fill"] } }],
      idempotencyKey: "design-system-clear-token-reference-0001",
      message: "Stop using release token",
    });
    expect(cleared.revision.version).toBe(4);
    const release2 = systems.createRelease("local", system.id, {
      expectedLatestVersion: 1,
      name: "Release 2",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const upgrade = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(upgrade.status).toBe("ready");
    expect(upgrade.diagnostics).toContainEqual(expect.objectContaining({
      code: "TOKEN_REMOVED",
      safety: "review_required",
    }));
    systems.commitProjectUpgrade("local", {
      previewId: upgrade.id,
      expectedPreviewHash: upgrade.previewHash,
    });
    const beforeRestore = persistedState(database, design.design.id);

    let caught: unknown;
    try {
      designer.restoreRevision("local", design.design.id, {
        targetVersion: 3,
        expectedBaseVersion: 5,
        idempotencyKey: "design-system-incompatible-restore-0001",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        reasonCode: "RESTORE_DESIGN_SYSTEM_INCOMPATIBLE",
        targetVersion: 3,
        diagnostics: expect.arrayContaining([expect.objectContaining({
          code: "USED_TOKEN_REMOVED",
          severity: "error",
          safety: "blocked",
          entityId: tokenId,
        })]),
      },
    });
    expect(persistedState(database, design.design.id)).toEqual(beforeRestore);
    expect(systems.readProjectPin("local", design.design.id)).toMatchObject({
      releaseId: release2.id,
      releaseVersion: 2,
    });
    expect(designer.getDesign("local", design.design.id).revision.version).toBe(5);
  });

  it("allows V1 restores and Foundation-backed V2 restores when no project pin row exists", () => {
    const { database, designer, design } = setup();
    const backupId = "backup_designsystemrestore02";
    seedVerifiedMigrationBackup(database, backupId, design.design.updatedAt);
    designer.migrateDesignHeadToV2("local", design.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "design-system-v2-restore-migration-0002",
    });
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM project_design_system_pins WHERE design_id = ?",
    ).get(design.design.id)).toEqual({ count: 0 });

    const foundationRestore = designer.restoreRevision("local", design.design.id, {
      targetVersion: 2,
      expectedBaseVersion: 2,
      idempotencyKey: "design-system-foundation-restore-0001",
    });
    expect(foundationRestore.schemaVersion).toBe(2);
    expect(foundationRestore.revision.version).toBe(3);
    expect(foundationRestore.restore.designSystem.status).toBe("active_pin_unchanged");

    const v1Restore = designer.restoreRevision("local", design.design.id, {
      targetVersion: 1,
      expectedBaseVersion: 3,
      idempotencyKey: "design-system-v1-restore-0001",
    });
    expect(v1Restore.schemaVersion).toBe(1);
    expect(v1Restore.revision.version).toBe(4);
    expect(v1Restore.restore.designSystem).toEqual({
      status: "not_applicable_v1",
      pinSource: null,
      active: null,
      historical: null,
      compatibilityDiagnostics: [],
    });

    const foundationFromV1 = designer.restoreRevision("local", design.design.id, {
      targetVersion: 2,
      expectedBaseVersion: 4,
      idempotencyKey: "design-system-foundation-restore-0002",
    });
    expect(foundationFromV1.schemaVersion).toBe(2);
    expect(foundationFromV1.revision.version).toBe(5);
    if (foundationFromV1.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(foundationFromV1.canonicalDocument.design_system).toEqual({
      design_system_id: "system_formaspec_foundation",
      release_id: "release_formaspec_foundation_1",
      release_version: 1,
    });
  });

  it("persists blocked upgrade diagnostics and rejects stale or expired preview commits", () => {
    const { systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Risky System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(systems, system.id, 1, 1, 1);
    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });

    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token(8, "spacing"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2, { removeLabel: true }),
    });
    const release2 = createPublishedRelease(systems, system.id, 2, 2, 2);
    const blocked = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release2.id,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.canCommit).toBe(false);
    expect(blocked.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TOKEN_FAMILY_CHANGED", severity: "error", safety: "blocked" }),
      expect.objectContaining({ code: "COMPONENT_CONTRACT_REVIEW_REQUIRED", severity: "warning" }),
    ]));
    expect(systems.readUpgradePreview("local", blocked.id).diagnostics).toEqual(blocked.diagnostics);
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: blocked.id,
      expectedPreviewHash: blocked.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_NOT_COMMITTABLE" }));

    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 2,
      status: "published",
      token: token("#0f172a"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 2,
      definition: component(3),
    });
    const release3 = createPublishedRelease(systems, system.id, 3, 3, 3);
    setTime("2026-07-19T11:00:00.000Z");
    const expiring = systems.previewProjectUpgrade("local", {
      designId: design.design.id,
      targetReleaseId: release3.id,
    });
    setTime("2026-07-19T11:16:00.000Z");
    expect(() => systems.commitProjectUpgrade("local", {
      previewId: expiring.id,
      expectedPreviewHash: expiring.previewHash,
    })).toThrow(expect.objectContaining({ code: "PREVIEW_EXPIRED" }));
  });

  it("enforces organization-administrator writes and project pin compare-and-swap", () => {
    const { database, systems, design, setTime } = setup();
    const system = systems.createDesignSystem("local", { name: "Restricted System" });
    systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release = createPublishedRelease(systems, system.id, 1, 1, 1);

    const viewer = resolveAccess(database.sqlite, "viewer@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);
    expect(systems.readDesignSystem("viewer@example.com", system.id).id).toBe(system.id);
    expect(() => systems.createDesignSystem("viewer@example.com", { name: "Denied" }))
      .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    expect(() => systems.pinProject("local", {
      designId: design.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    })).toThrow(expect.objectContaining({ code: "VERSION_CONFLICT" }));

    setTime("2026-07-19T12:00:00.000Z");
    const archived = systems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      status: "archived",
    });
    expect(archived.status).toBe("archived");
    expect(() => systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#ffffff"),
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("lets design editors author typed drafts and creates immutable publish/deprecate versions", () => {
    const { database, systems } = setup();
    const system = systems.createDesignSystem("local", { name: "Component Authoring System" });
    const editor = resolveAccess(database.sqlite, "design-editor@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'design_editor' WHERE organization_id = ? AND principal_id = ?",
    ).run(editor.organizationId, editor.principalId);
    const viewer = resolveAccess(database.sqlite, "component-viewer@example.com");
    database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);

    const draftDefinition = {
      ...component(1, { status: "draft" }),
      properties_schema: [
        { key: "label", label: "Label", required: true, type: "text" as const, default: "Continue", max_length: 80 },
        { key: "emphasis", label: "Emphasis", required: false, type: "enum" as const, values: ["high", "low"], default: "high" },
        { key: "loading", label: "Loading", required: false, type: "boolean" as const, default: false },
      ],
      slots: [{
        key: "leading",
        name: "Leading content",
        required: false,
        min_items: 0,
        max_items: 1,
        allowed_node_types: ["icon" as const, "image" as const],
      }],
      states: [
        { key: "default" as const, name: "Default", node_id: "node_primarybuttonroot001" },
        { key: "focused" as const, name: "Focused", node_id: "node_primarybuttonfocus001" },
        { key: "loading" as const, name: "Loading", node_id: "node_primarybuttonload0001" },
      ],
    };
    const draft = systems.createComponentVersion("design-editor@example.com", system.id, {
      expectedLatestVersion: 0,
      definition: draftDefinition,
    });
    expect(draft).toMatchObject({ version: 1, status: "draft" });

    const visibleDraft = systems.listComponentDefinitions("component-viewer@example.com", system.id);
    expect(visibleDraft).toEqual([
      expect.objectContaining({
        componentId: draft.componentId,
        version: 1,
        isLatest: true,
        versionCount: 1,
        diagnostics: [expect.objectContaining({ code: "COMPONENT_DRAFT_REVIEW_REQUIRED" })],
      }),
    ]);

    const published = systems.transitionComponentLifecycle("design-editor@example.com", system.id, draft.componentId, {
      expectedLatestVersion: 1,
      targetStatus: "published",
    });
    expect(published).toMatchObject({ version: 2, status: "published" });
    expect(published.definition.properties_schema).toEqual(draft.definition.properties_schema);
    expect(published.definition.slots).toEqual(draft.definition.slots);
    expect(published.definition.states).toEqual(draft.definition.states);

    const replacementDraft = systems.createComponentVersion("design-editor@example.com", system.id, {
      expectedLatestVersion: 0,
      definition: component(1, {
        id: "component_actionbuttonnew001",
        key: "button.action",
        name: "Action button",
        rootNodeId: "node_actionbuttonroot0001",
        status: "draft",
      }),
    });
    const replacement = systems.transitionComponentLifecycle("design-editor@example.com", system.id, replacementDraft.componentId, {
      expectedLatestVersion: 1,
      targetStatus: "published",
    });
    const deprecated = systems.transitionComponentLifecycle("design-editor@example.com", system.id, draft.componentId, {
      expectedLatestVersion: 2,
      targetStatus: "deprecated",
      replacementComponentId: replacement.componentId,
    });
    expect(deprecated).toMatchObject({ version: 3, status: "deprecated" });

    const latest = systems.listComponentDefinitions("component-viewer@example.com", system.id);
    expect(latest.find((item) => item.componentId === draft.componentId)).toMatchObject({
      version: 3,
      versionCount: 3,
      replacement: {
        componentId: replacement.componentId,
        version: 2,
        status: "published",
        name: "Action button",
      },
      diagnostics: [],
    });
    const history = systems.listComponentDefinitions("component-viewer@example.com", system.id, true)
      .filter((item) => item.componentId === draft.componentId);
    expect(history.map((item) => [item.version, item.status, item.isLatest])).toEqual([
      [3, "deprecated", true],
      [2, "published", false],
      [1, "draft", false],
    ]);
    expect(history[1]?.diagnostics[0]?.code).toBe("COMPONENT_VERSION_IMMUTABLE");
    expect(() => systems.transitionComponentLifecycle("component-viewer@example.com", system.id, replacement.componentId, {
      expectedLatestVersion: 2,
      targetStatus: "deprecated",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    const persisted = database.sqlite.prepare(
      "SELECT version, status FROM component_definitions WHERE design_system_id = ? AND component_id = ? ORDER BY version",
    ).all(system.id, draft.componentId) as Array<{ version: number; status: string }>;
    expect(persisted).toEqual([
      { version: 1, status: "draft" },
      { version: 2, status: "published" },
      { version: 3, status: "deprecated" },
    ]);
  });

  it("reports component-authoring permission explicitly for every human organization role", () => {
    const { database, systems } = setup();
    const system = systems.createDesignSystem("local", { name: "Role Capability System" });
    expect(systems.readComponentAuthoringPermission("local", system.id)).toEqual({
      designSystemId: system.id,
      canAuthorComponents: true,
    });

    const roles = [
      ["design-editor-capability@example.com", "design_editor", true],
      ["product-manager-capability@example.com", "product_manager", false],
      ["engineer-capability@example.com", "engineer", false],
      ["viewer-capability@example.com", "viewer", false],
    ] as const;
    for (const [actorId, role, expected] of roles) {
      const access = resolveAccess(database.sqlite, actorId);
      database.sqlite.prepare(
        "UPDATE memberships SET role = ? WHERE organization_id = ? AND principal_id = ?",
      ).run(role, access.organizationId, access.principalId);
      expect(systems.readComponentAuthoringPermission(actorId, system.id)).toEqual({
        designSystemId: system.id,
        canAuthorComponents: expected,
      });
      expect(systems.listComponentDefinitions(actorId, system.id)).toEqual([]);
      if (!expected) {
        expect(() => systems.createComponentVersion(actorId, system.id, {
          expectedLatestVersion: 0,
          definition: component(1, { status: "draft" }),
        })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
      }
    }
  });

  it("reopens immutable releases, pins, and upgrade previews from a migrated database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-design-system-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "designer.sqlite");
    const first = setup(filename);
    const system = first.systems.createDesignSystem("local", { name: "Persistent System" });
    first.systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 0,
      status: "published",
      token: token("#2457e6"),
    });
    first.systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 0,
      definition: component(1),
    });
    const release1 = createPublishedRelease(first.systems, system.id, 1, 1, 1);
    first.systems.pinProject("local", {
      designId: first.design.design.id,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
    first.systems.createTokenVersion("local", system.id, {
      expectedLatestVersion: 1,
      status: "published",
      token: token("#1d45b8"),
    });
    first.systems.createComponentVersion("local", system.id, {
      expectedLatestVersion: 1,
      definition: component(2),
    });
    const release2 = createPublishedRelease(first.systems, system.id, 2, 2, 2);
    const preview = first.systems.previewProjectUpgrade("local", {
      designId: first.design.design.id,
      targetReleaseId: release2.id,
    });

    first.database.close();
    databases.splice(databases.indexOf(first.database), 1);
    const reopened = new DesignerDatabase(filename);
    databases.push(reopened);
    const reopenedDesigner = new DesignerService(reopened, new EventHub(), 900);
    const service = new DesignSystemService(reopened, {
      now: () => new Date("2026-07-19T10:10:00.000Z"),
      upgradePreviewTtlSeconds: 900,
      designerService: reopenedDesigner,
    });
    expect(service.readDesignSystem("local", system.id).name).toBe("Persistent System");
    expect(service.readRelease("local", release2.id).tokenVersions).toEqual([
      { tokenId: "token_primaryaction0001", version: 2 },
    ]);
    expect(service.readProjectPin("local", first.design.design.id).releaseId).toBe(release1.id);
    expect(service.readUpgradePreview("local", preview.id)).toMatchObject({
      id: preview.id,
      status: "ready",
      previewHash: preview.previewHash,
    });
  });
});
