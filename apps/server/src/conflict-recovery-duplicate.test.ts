import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createComponentNode, createSequentialIdFactory } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPayload } from "./ids.js";
import { operationHash, revisionHash } from "./persistence.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function localApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-conflict-recovery-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
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
  applications.push(application);
  await application.app.ready();
  return application;
}

async function persistentLocalApplication(root: string): Promise<DesignerApplication> {
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: path.join(root, "data", "designer.sqlite"),
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function closeTrackedApplication(application: DesignerApplication): Promise<void> {
  const index = applications.indexOf(application);
  if (index >= 0) applications.splice(index, 1);
  await application.app.close();
}

function createProject(application: DesignerApplication, key: string, name = "Conflict source") {
  return application.service.createDesign("local", {
    name,
    preset: "phone",
    idempotencyKey: key,
  });
}

function firstEditableNode(document: ReturnType<DesignerApplication["service"]["getDesign"]>["document"]) {
  const node = Object.values(document.nodes).find((candidate) => candidate.type === "text")
    ?? Object.values(document.nodes)[0];
  if (!node) throw new Error("Starter document did not contain a node.");
  return node;
}

function seedVerifiedMigrationBackup(application: DesignerApplication, designUpdatedAt: string): string {
  const id = `backup_${"b".repeat(40)}`;
  const createdAt = new Date(Math.max(Date.now(), Date.parse(designUpdatedAt)) + 1_000).toISOString();
  const manifest = {
    format: "formaspec-backup",
    formatVersion: 1,
    createdAt,
    databaseSchemaVersion: application.database.schemaVersion(),
  };
  const verification = {
    valid: true,
    manifest,
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at,
      verified_at, size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'conflict-recovery-migration.tar', ?, 'valid', ?,
             'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    "a".repeat(64),
    JSON.stringify(manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
  return id;
}

function installAgentGrant(application: DesignerApplication, input: {
  id: string;
  organizationId?: string;
  projectIds: string[];
}): string {
  const organizationId = input.organizationId ?? "organization_legacy";
  const principalId = `principal_${input.id}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  application.database.sqlite.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?)`,
  ).run(organizationId, `Organization ${organizationId}`, now.toISOString(), now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, input.id, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, 'agent', ?)`,
  ).run(organizationId, principalId, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    `connection_${input.id}`,
    organizationId,
    principalId,
    input.id,
    JSON.stringify(["design:read", "design:write"]),
    JSON.stringify(input.projectIds),
    expiresAt,
    now.toISOString(),
    now.toISOString(),
  );
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    organizationId,
    principalId,
    createHash("sha256").update(`token:${input.id}`).digest("hex"),
    JSON.stringify(["design:read", "design:write"]),
    JSON.stringify(input.projectIds),
    now.toISOString(),
    expiresAt,
  );
  return `grant_${input.id}`;
}

function mutationCounts(application: DesignerApplication) {
  return Object.fromEntries([
    "designs",
    "revisions",
    "snapshots",
    "assets",
    "product_specifications",
    "implementation_mappings",
    "audit_events",
    "event_outbox",
    "idempotency",
  ].map((table) => [
    table,
    (application.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  ]));
}

describe("conflicting local draft duplication", () => {
  it("duplicates an exact stale base through REST, remaps temporary IDs, and replays the committed result", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-stale-create-0001");
    const baseNode = firstEditableNode(created.document);
    const advanced = application.service.applyRevision("local", created.design.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: baseNode.id,
        patch: { name: "Remote head edit" },
      }],
      idempotencyKey: "conflict-stale-head-0001",
      message: "Advance source head",
    });
    expect(advanced.design.version).toBe(2);

    const payload = {
      baseVersion: 1,
      operations: [{
        type: "upsert_token",
        token: {
          id: "tmp:accent",
          name: "Recovered accent",
          path: "color.recovered",
          kind: "color",
          value: "#7857ff",
          archived: false,
          metadata: {},
        },
      }, {
        type: "update_node",
        node_id: baseNode.id,
        patch: { name: "Recovered local edit" },
      }],
      idempotencyKey: "conflict-stale-duplicate-0001",
      name: "Recovered checkout",
    };
    const duplicated = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(duplicated.statusCode).toBe(201);
    const result = duplicated.json<{
      duplicated: true;
      source: { baseVersion: number; currentVersion: number; currentRevisionId: string };
      project: {
        id: string;
        name: string;
        version: number;
        revisionId: string;
        snapshotHash: string;
        operationHash: string;
        revisionHash: string;
        schemaVersion: number;
      };
      idMapping: Record<string, string>;
      diagnostics: Array<{ code: string }>;
      deepLink: string;
    }>();
    expect(result).toMatchObject({
      duplicated: true,
      source: { baseVersion: 1, currentVersion: 2, currentRevisionId: advanced.revision.id },
      project: { name: "Recovered checkout", version: 1, schemaVersion: 1 },
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CONFLICT_RECOVERY_DUPLICATED" }),
    ]));
    expect(result.project.id).not.toBe(created.design.id);
    expect(result.idMapping[created.design.id]).toBe(result.project.id);
    expect(result.idMapping["tmp:accent"]).toMatch(/^token_[a-f0-9]{32}$/);
    expect(result.deepLink).toBe(`/design/${encodeURIComponent(result.project.id)}`);

    const recovered = application.service.getDesign("local", result.project.id);
    expect(recovered.revision).toMatchObject({
      id: result.project.revisionId,
      snapshotHash: result.project.snapshotHash,
      operationHash: result.project.operationHash,
      revisionHash: result.project.revisionHash,
    });
    expect(recovered.canonicalDocument.tokens[result.idMapping["tmp:accent"]!]).toMatchObject({
      name: "Recovered accent",
      value: "#7857ff",
    });
    const storedRevision = application.database.sqlite.prepare(
      `SELECT actor_id, message, operations_json, snapshot_hash, operation_hash,
              revision_hash, created_at
       FROM revisions WHERE id = ?`,
    ).get(result.project.revisionId) as {
      actor_id: string;
      message: string;
      operations_json: string;
      snapshot_hash: string;
      operation_hash: string;
      revision_hash: string;
      created_at: string;
    };
    const storedOperations = JSON.parse(storedRevision.operations_json) as Array<{
      node_id?: string;
      token?: { id?: string };
    }>;
    expect(storedOperations[0]?.token?.id).toBe(result.idMapping["tmp:accent"]);
    expect(storedOperations[1]?.node_id).toBe(result.idMapping[baseNode.id]);
    expect(JSON.stringify(storedOperations)).not.toContain("tmp:accent");
    expect(JSON.stringify(storedOperations)).not.toContain(baseNode.id);
    expect(operationHash(storedOperations)).toBe(result.project.operationHash);
    expect(revisionHash({
      parentRevisionHash: null,
      snapshotHash: storedRevision.snapshot_hash,
      operationHash: storedRevision.operation_hash,
      metadata: {
        id: result.project.revisionId,
        designId: result.project.id,
        version: 1,
        parentRevisionId: null,
        actorId: storedRevision.actor_id,
        message: storedRevision.message,
        createdAt: storedRevision.created_at,
      },
    })).toBe(result.project.revisionHash);
    expect(application.service.getDesign("local", created.design.id)).toMatchObject({
      design: { version: 2, revisionId: advanced.revision.id },
    });

    const replay = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(result);
    expect((application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM designs WHERE id = ?",
    ).get(result.project.id) as { count: number }).count).toBe(1);
    expect(application.database.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'design.conflict_recovery_duplicate' AND target_id = ?`,
    ).get(result.project.id)).toEqual({ count: 1 });
    expect(application.database.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'design.created' AND json_extract(payload_json, '$.designId') = ?`,
    ).get(result.project.id)).toEqual({ count: 1 });

    const idempotencyConflict = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload: { ...payload, name: "Different recovered project" },
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const unknown = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload: { ...payload, path: "/tmp/project", source: "caller-controlled" },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const oversized = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload: {
        baseVersion: 1,
        operations: Array.from({ length: 501 }, () => null),
        idempotencyKey: "conflict-oversized-operations-0001",
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json<{ error: { code: string } }>().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects operations whose canonical target-ID form expands beyond 1 MiB", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-expanded-limit-create-0001");
    const baseNode = firstEditableNode(created.document);
    const pageId = created.document.pages[0]!.id;
    const content = "x".repeat(100_000);
    const operations: unknown[] = [
      {
        type: "create_tree",
        parent: { page_id: pageId },
        root_ids: ["tmp:a"],
        nodes: [{
          ...baseNode,
          id: "tmp:a",
          name: "Temporary expansion node",
        }],
      },
      ...Array.from({ length: 9 }, (_, index) => ({
        type: "update_node",
        node_id: baseNode.id,
        patch: { metadata: { filler: `${index}${content.slice(1)}` } },
      })),
      {
        type: "archive_nodes",
        node_ids: Array.from({ length: 5_000 }, () => "tmp:a"),
      },
    ];
    expect(operations).toHaveLength(11);
    expect(Buffer.byteLength(JSON.stringify(operations), "utf8")).toBeLessThanOrEqual(1_048_576);
    const before = mutationCounts(application);

    expect(() => application.operations.duplicateConflictingDraft("local", created.design.id, {
      baseVersion: 1,
      operations,
      idempotencyKey: "conflict-expanded-limit-duplicate-0001",
    })).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 }));
    expect(mutationCounts(application)).toEqual(before);
  });

  it("clones V1 assets, tokens, prototype links, and the product specification without sharing project IDs", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-v1-create-0001", "V1 asset source");
    const basePage = created.document.pages[0]!;
    const baseNode = firstEditableNode(created.document);
    const bytes = Buffer.from("deterministic-conflict-recovery-image");
    const savedAsset = application.service.saveAsset("local", {
      designId: created.design.id,
      filename: "checkout.png",
      mimeType: "image/png",
      width: 2,
      height: 3,
      data: bytes,
    });
    const specificationPreview = application.enterprise.previewProductSpecification("local", {
      designId: created.design.id,
      baseVersion: 0,
      naturalLanguageBrief: "Preserve the checkout asset and prototype behavior during recovery.",
    });
    application.enterprise.commitProductSpecificationPreview("local", {
      designId: created.design.id,
      previewId: specificationPreview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "conflict-v1-specification-0001",
      message: "Seed recovery specification",
    });
    const linkId = "link_conflictrecovery0001";
    const tokenId = "token_conflictrecovery0001";
    const withAssets = application.service.applyRevision("local", created.design.id, {
      baseVersion: 1,
      idempotencyKey: "conflict-v1-assets-0001",
      operations: [
        {
          type: "upsert_asset",
          asset: {
            id: savedAsset.id,
            name: savedAsset.filename,
            kind: "image",
            mime_type: savedAsset.mimeType,
            size_bytes: savedAsset.sizeBytes,
            storage_key: `asset:${savedAsset.id}`,
            sha256: savedAsset.sha256,
            width: savedAsset.width,
            height: savedAsset.height,
            metadata: {},
          },
        },
        {
          type: "upsert_token",
          token: {
            id: tokenId,
            name: "Checkout accent",
            path: "color.checkout",
            kind: "color",
            value: "#223344",
            archived: false,
            metadata: {},
          },
        },
        {
          type: "set_prototype_link",
          link: {
            id: linkId,
            source_node_id: baseNode.id,
            trigger: { type: "click" },
            action: { type: "navigate", page_id: basePage.id },
            metadata: {},
          },
        },
      ],
      message: "Attach V1 recovery evidence",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const laterSpecificationPreview = application.enterprise.previewProductSpecification("local", {
      designId: created.design.id,
      baseVersion: 1,
      naturalLanguageBrief: "This later product brief must not leak into a stale recovered base.",
    });
    application.enterprise.commitProductSpecificationPreview("local", {
      designId: created.design.id,
      previewId: laterSpecificationPreview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "conflict-v1-specification-later-0001",
      message: "Commit a product specification after the recovered design base",
    });
    application.service.applyRevision("local", created.design.id, {
      baseVersion: 2,
      operations: [{ type: "update_node", node_id: baseNode.id, patch: { name: "New source head" } }],
      idempotencyKey: "conflict-v1-head-0001",
    });

    const result = application.operations.duplicateConflictingDraft("local", created.design.id, {
      baseVersion: withAssets.revision.version,
      operations: [],
      idempotencyKey: "conflict-v1-duplicate-0001",
    });
    const recovered = application.service.getDesign("local", result.project.id).canonicalDocument;
    expect(recovered.schema_version).toBe(1);
    const targetAssetId = result.idMapping[savedAsset.id]!;
    const targetTokenId = result.idMapping[tokenId]!;
    const targetLinkId = result.idMapping[linkId]!;
    expect(targetAssetId).not.toBe(savedAsset.id);
    expect(recovered.assets[targetAssetId]).toMatchObject({
      id: targetAssetId,
      storage_key: `asset:${targetAssetId}`,
      sha256: savedAsset.sha256,
    });
    expect(application.service.getAsset("local", targetAssetId)).toMatchObject({
      designId: result.project.id,
      data: bytes,
      sha256: savedAsset.sha256,
    });
    expect(recovered.tokens[targetTokenId]).toMatchObject({ value: "#223344" });
    expect(recovered.prototype_links[targetLinkId]).toMatchObject({
      id: targetLinkId,
      source_node_id: result.idMapping[baseNode.id],
      action: { page_id: result.idMapping[basePage.id] },
    });
    expect(application.enterprise.readProductSpecification("local", result.project.id)).toMatchObject({
      version: 1,
      specification: {
        natural_language_brief: "Preserve the checkout asset and prototype behavior during recovery.",
      },
      revisionId: result.project.revisionId,
    });
    expect(application.enterprise.readProductSpecification("local", created.design.id)).toMatchObject({
      version: 2,
      specification: {
        natural_language_brief: "This later product brief must not leak into a stale recovered base.",
      },
    });
    expect(result.project).toMatchObject({
      assetCount: 1,
      productSpecificationVersion: 1,
    });
    expect(application.service.getAsset("local", savedAsset.id)).toMatchObject({
      designId: created.design.id,
      data: bytes,
    });
  });

  it("replays the exact committed response after a database restart", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-conflict-restart-"));
    temporaryDirectories.push(root);
    const first = await persistentLocalApplication(root);
    const created = createProject(first, "conflict-restart-create-0001");
    const payload = {
      baseVersion: 1,
      operations: [],
      idempotencyKey: "conflict-restart-duplicate-0001",
      name: "Restart-safe recovered draft",
    };
    const committed = await first.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(committed.statusCode).toBe(201);
    const committedResult = committed.json();
    await closeTrackedApplication(first);

    const restarted = await persistentLocalApplication(root);
    const replay = await restarted.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(committedResult);
    expect((restarted.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM designs WHERE name = 'Restart-safe recovered draft'",
    ).get() as { count: number }).count).toBe(1);
  });

  it("preserves strict V2 content and rebases its embedded product specification to version 1", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-v2-create-0001", "V2 source");
    const component = createComponentNode({
      name: "Checkout action",
      component_key: "checkout.action",
      description: "A project-local checkout action component.",
    }, createSequentialIdFactory("conflict_component"));
    const withComponent = application.service.applyRevision("local", created.design.id, {
      baseVersion: 1,
      operations: [{
        type: "create_tree",
        parent: { page_id: created.document.pages[0]!.id },
        root_ids: [component.id],
        nodes: [component],
      }],
      idempotencyKey: "conflict-v2-component-0001",
    });
    const backupId = seedVerifiedMigrationBackup(application, withComponent.design.updatedAt);
    const migrated = application.service.migrateDesignHeadToV2("local", created.design.id, {
      expectedBaseVersion: 2,
      backupId,
      idempotencyKey: "conflict-v2-migrate-0001",
    }).result;
    expect(migrated.schemaVersion).toBe(2);
    if (migrated.canonicalDocument.schema_version !== 2) throw new Error("Expected a strict V2 source.");
    const inventoryId = `inventory_${"c".repeat(32)}`;
    const sourceMappingId = `mapping_${"d".repeat(32)}`;
    const sourcePageId = migrated.canonicalDocument.pages[0]!.id;
    const inventoryHash = "e".repeat(64);
    const repositoryFingerprint = "f".repeat(64);
    application.database.sqlite.prepare(
      `INSERT INTO repository_inventories
       (id, organization_id, repository_fingerprint, inventory_hash, inventory_json, status, created_by, created_at)
       VALUES (?, 'organization_legacy', ?, ?, '{}', 'active', 'principal_local', ?)`,
    ).run(inventoryId, repositoryFingerprint, inventoryHash, new Date().toISOString());
    application.database.sqlite.prepare(
      `INSERT INTO implementation_mappings
       (id, organization_id, design_id, revision_id, inventory_id, entity_kind, entity_id,
        platform, symbol, mapping_json, created_by, created_at)
       VALUES (?, 'organization_legacy', ?, ?, ?, 'screen', ?, 'web', 'CheckoutScreen', ?,
               'principal_local', ?)`,
    ).run(
      sourceMappingId,
      created.design.id,
      migrated.revision.id,
      inventoryId,
      sourcePageId,
      JSON.stringify({
        schemaVersion: 1,
        designPin: {
          designId: created.design.id,
          revisionId: migrated.revision.id,
          designVersion: 3,
          snapshotHash: migrated.revision.snapshotHash,
          revisionHash: migrated.revision.revisionHash,
        },
        productSpecificationPin: {
          source: "document",
          version: migrated.canonicalDocument.product_specification.version,
          hash: hashPayload(migrated.canonicalDocument.product_specification),
        },
        inventoryPin: { inventoryId, inventoryHash, repositoryFingerprint, platform: "web" },
        designEntity: { kind: "screen", id: sourcePageId },
        sourceEntity: {
          id: `inv_${"1".repeat(40)}`,
          kind: "screen",
          symbol: "CheckoutScreen",
          locationId: `loc_${"2".repeat(40)}`,
          line: 10,
        },
      }),
      new Date().toISOString(),
    );
    const baseNode = firstEditableNode(migrated.document);
    const advanced = application.service.applyRevision("local", created.design.id, {
      baseVersion: 3,
      operations: [{ type: "update_node", node_id: baseNode.id, patch: { name: "V2 head moved" } }],
      idempotencyKey: "conflict-v2-head-0001",
    });
    expect(advanced.design.version).toBe(4);
    const tokenId = "token_v2conflictrecovery0001";
    const result = application.operations.duplicateConflictingDraft("local", created.design.id, {
      baseVersion: 3,
      operations: [{
        type: "upsert_token",
        token: {
          id: tokenId,
          name: "Recovered V2 token",
          path: "color.v2_recovered",
          kind: "color",
          value: "#102030",
          archived: false,
          metadata: { layer: "primitive" },
        },
      }],
      idempotencyKey: "conflict-v2-duplicate-0001",
    });
    const recovered = application.service.getDesign("local", result.project.id).canonicalDocument;
    expect(recovered.schema_version).toBe(2);
    if (recovered.schema_version !== 2 || migrated.canonicalDocument.schema_version !== 2) {
      throw new Error("Expected strict V2 documents.");
    }
    expect(recovered.revision).toBe(1);
    expect(recovered.tokens[result.idMapping[tokenId]!]).toMatchObject({
      id: result.idMapping[tokenId],
      value: "#102030",
    });
    expect(recovered.product_specification).toMatchObject({
      id: result.idMapping[migrated.canonicalDocument.product_specification.id],
      version: 1,
    });
    expect(recovered.design_system).toEqual(migrated.canonicalDocument.design_system);
    expect(Object.keys(migrated.canonicalDocument.component_definitions)).not.toHaveLength(0);
    for (const componentId of Object.keys(migrated.canonicalDocument.component_definitions)) {
      expect(recovered.component_definitions[result.idMapping[componentId]!]).toBeDefined();
    }
    expect(result.project.implementationMappingCount).toBe(1);
    const targetMappingId = result.idMapping[sourceMappingId]!;
    expect(targetMappingId).toMatch(/^mapping_[a-f0-9]{32}$/);
    const clonedMapping = application.database.sqlite.prepare(
      "SELECT * FROM implementation_mappings WHERE id = ?",
    ).get(targetMappingId) as {
      design_id: string;
      revision_id: string;
      inventory_id: string;
      entity_id: string;
      mapping_json: string;
    };
    expect(clonedMapping).toMatchObject({
      design_id: result.project.id,
      revision_id: result.project.revisionId,
      inventory_id: inventoryId,
      entity_id: result.idMapping[sourcePageId],
    });
    expect(JSON.parse(clonedMapping.mapping_json)).toMatchObject({
      designPin: {
        designId: result.project.id,
        revisionId: result.project.revisionId,
        designVersion: 1,
        snapshotHash: result.project.snapshotHash,
        revisionHash: result.project.revisionHash,
      },
      productSpecificationPin: { source: "document", version: 1 },
      designEntity: { kind: "screen", id: result.idMapping[sourcePageId] },
      inventoryPin: { inventoryId, inventoryHash, repositoryFingerprint },
    });
    expect(application.database.sqlite.prepare(
      "SELECT design_id, revision_id, entity_id FROM implementation_mappings WHERE id = ?",
    ).get(sourceMappingId)).toEqual({
      design_id: created.design.id,
      revision_id: migrated.revision.id,
      entity_id: sourcePageId,
    });
    expect(application.service.getDesign("local", created.design.id)).toMatchObject({
      design: { version: 4, revisionId: advanced.revision.id },
    });
  });

  it("preserves an exact historical custom design-system pin after the source system is archived", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-archived-system-create-0001", "Archived system source");
    const system = application.designSystems.createDesignSystem("local", {
      name: "Historical recovery system",
    });
    const release = application.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Historical release",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    application.designSystems.pinProject("local", {
      designId: created.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    const backupId = seedVerifiedMigrationBackup(application, created.design.updatedAt);
    const migrated = application.service.migrateDesignHeadToV2("local", created.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "conflict-archived-system-migrate-0001",
    }).result;
    if (migrated.canonicalDocument.schema_version !== 2) throw new Error("Expected a strict V2 source.");
    expect(migrated.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release.id,
      release_version: release.version,
    });
    application.designSystems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: system.updatedAt,
      status: "archived",
    });

    const result = application.operations.duplicateConflictingDraft("local", created.design.id, {
      baseVersion: migrated.revision.version,
      operations: [],
      idempotencyKey: "conflict-archived-system-duplicate-0001",
    });
    const recovered = application.service.getDesign("local", result.project.id).canonicalDocument;
    if (recovered.schema_version !== 2) throw new Error("Expected a strict V2 recovered project.");
    expect(recovered.design_system).toEqual(migrated.canonicalDocument.design_system);
    expect(application.database.sqlite.prepare(
      `SELECT design_system_id, release_id, release_version
       FROM project_design_system_pins WHERE design_id = ?`,
    ).get(result.project.id)).toEqual({
      design_system_id: system.id,
      release_id: release.id,
      release_version: release.version,
    });
  });

  it("allows archive operations only in the new project and leaves the source tree active", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-archive-create-0001");
    const sourceNode = firstEditableNode(created.document);
    const result = application.operations.duplicateConflictingDraft("local", created.design.id, {
      baseVersion: 1,
      operations: [{ type: "archive_nodes", node_ids: [sourceNode.id] }],
      idempotencyKey: "conflict-archive-duplicate-0001",
    });
    const targetNodeId = result.idMapping[sourceNode.id]!;
    expect(application.service.getDesign("local", result.project.id).canonicalDocument.nodes[targetNodeId]).toMatchObject({
      archived: true,
    });
    expect(application.service.getDesign("local", created.design.id).canonicalDocument.nodes[sourceNode.id]).toMatchObject({
      archived: false,
    });
  });

  it("rolls back project, snapshot, revision, audit, outbox, and idempotency rows together", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-rollback-create-0001");
    const before = mutationCounts(application);
    application.database.sqlite.exec(`
      CREATE TRIGGER conflict_recovery_revision_failure
      BEFORE INSERT ON revisions
      WHEN NEW.design_id <> '${created.design.id}'
      BEGIN SELECT RAISE(ABORT, 'forced conflict recovery rollback'); END;
    `);
    const payload = {
      baseVersion: 1,
      operations: [],
      idempotencyKey: "conflict-rollback-duplicate-0001",
    };
    const failed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(failed.statusCode).toBe(500);
    expect(mutationCounts(application)).toEqual(before);

    application.database.sqlite.exec("DROP TRIGGER conflict_recovery_revision_failure");
    const retried = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/conflict-recovery/duplicate`,
      payload,
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ duplicated: true, project: { version: 1 } });
  });

  it("rejects project-restricted creators and hides source projects from another organization", async () => {
    const application = await localApplication();
    const created = createProject(application, "conflict-auth-create-0001");
    const restrictedActor = installAgentGrant(application, {
      id: "conflict_restricted_writer",
      projectIds: [created.design.id],
    });
    expect(() => application.operations.duplicateConflictingDraft(restrictedActor, created.design.id, {
      baseVersion: 1,
      operations: [],
      idempotencyKey: "conflict-auth-restricted-0001",
    })).toThrowError(expect.objectContaining({ code: "FORBIDDEN", statusCode: 403 }));

    const foreignActor = installAgentGrant(application, {
      id: "conflict_foreign_writer",
      organizationId: "organization_foreign_conflict",
      projectIds: [],
    });
    expect(() => application.operations.duplicateConflictingDraft(foreignActor, created.design.id, {
      baseVersion: 1,
      operations: [],
      idempotencyKey: "conflict-auth-foreign-0001",
    })).toThrowError(expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 }));
  });
});
