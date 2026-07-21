import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ComponentDefinitionSchema,
  DesignDocumentSchema,
  DesignOperationListSchema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  ProductSpecificationSchema,
  applyDesignOperations,
  createSequentialIdFactory,
  createStarterDocument,
  type DesignDocument,
  type DesignOperation,
} from "@designer/core";
import Database from "better-sqlite3";

import {
  applyDatabaseMigrationPrefixForTesting,
} from "../src/db/database.js";
import { canonicalJson, hashPayload } from "../src/ids.js";
import {
  canonicalSnapshot,
  operationHash,
  revisionHash,
  storeSnapshot,
} from "../src/persistence.js";
import {
  HandoffSpecificationSchema,
  UploadRepositoryInventorySchema,
} from "../src/workspace-handoff-service.js";

export type HistoricalFixtureVersion = 1 | 7 | 8 | 9 | 10 | 11 | 12;

const CREATED_AT = "2025-01-10T09:00:00.000Z";
const UPDATED_AT = "2025-01-10T09:15:00.000Z";
const MIGRATION_ACTOR = "local";
const ORGANIZATION_ID = "organization_legacy";
const PRINCIPAL_ID = "principal_local";
const HISTORICAL_RUNTIME_VERSIONS = Object.freeze({
  commandEngine: "1",
  renderer: "2",
  fontBundle: "1",
  application: "0.2.0",
  exportFormat: "1",
});

const DESIGN_ID = "document_historical_fixture0001";
const REVISION_ONE_ID = "revision_historical_fixture0001";
const REVISION_TWO_ID = "revision_historical_fixture0002";
const ASSET_ID = "asset_historical_fixture0001";
const PRODUCT_SPECIFICATION_ID = "spec_historical_fixture0001";
const DESIGN_SYSTEM_ID = "system_historical_fixture0001";
const DESIGN_SYSTEM_RELEASE_ID = "release_historical_fixture0001";
const DESIGN_SYSTEM_TOKEN_ID = "token_historical_fixture0001";
const COMPONENT_DEFINITION_ID = "component_historical_fixture0001";
const INVENTORY_ID = `inventory_${"1".repeat(32)}`;
const INVENTORY_ENTITY_ID = `inv_${"2".repeat(40)}`;
const INVENTORY_LOCATION_ID = `loc_${"3".repeat(40)}`;
const MAPPING_ID = `mapping_${"4".repeat(32)}`;
const HANDOFF_ID = `handoff_${"5".repeat(32)}`;
const RENDER_JOB_ID = `render_${"6".repeat(32)}`;
const UPGRADE_PREVIEW_ID = `upgrade_${"c".repeat(32)}`;
const HANDOFF_DECISION_ID = `decision_${"d".repeat(32)}`;

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

export const HISTORICAL_FIXTURE_IDS = Object.freeze({
  designId: DESIGN_ID,
  revisionOneId: REVISION_ONE_ID,
  revisionTwoId: REVISION_TWO_ID,
  assetId: ASSET_ID,
  productSpecificationId: PRODUCT_SPECIFICATION_ID,
  designSystemId: DESIGN_SYSTEM_ID,
  designSystemReleaseId: DESIGN_SYSTEM_RELEASE_ID,
  designSystemTokenId: DESIGN_SYSTEM_TOKEN_ID,
  componentDefinitionId: COMPONENT_DEFINITION_ID,
  inventoryId: INVENTORY_ID,
  inventoryEntityId: INVENTORY_ENTITY_ID,
  mappingId: MAPPING_ID,
  handoffId: HANDOFF_ID,
  renderJobId: RENDER_JOB_ID,
  upgradePreviewId: UPGRADE_PREVIEW_ID,
  handoffDecisionId: HANDOFF_DECISION_ID,
});

// These checked-in digests make a change to a historical schema or fixture
// payload an explicit review event instead of silently regenerating history.
export const HISTORICAL_FIXTURE_DIGESTS = Object.freeze({
  schema: Object.freeze({
    1: "5c3b529be0bdfd2f39942612d99675396b69020a8ca01fdef95a1128f8abe2a5",
    7: "3d3cc16ea43f90a8bb6b7da88eb14cfcab982b5ba7f3677f39472df3683a2135",
    8: "a2da6542f99714855aa2b2fb32c69e30ae5af63aeba914795ada9912b707e5ec",
    9: "c73fa93bb92f8e1286bb18a03c5796ea24191c59581acaf3c6c878d0a12497e8",
    10: "adb972b593455e420e41e7014745dbca6895d75c68dc0d30014bf49d1b6c8a8b",
    11: "19289adc25bb3509d49f4a32db829a3a5b91b6bf4d73f13ea91a6b5f6d33e349",
    12: "42d29aa43d861b9fe1c03bf415d00d076e980538a6fd9e92d230b0d255dbc2e8",
  }),
  revisionOneHash: "9c89905de248528229ae6866403e3cbe933ad5c12a6cff19a307664e0357644a",
  revisionTwoHash: "3ee525f955e7ab762f31a66aa89f5bd46ae9d60d85102780493c44a22e880e8a",
  assetSha256: "7ac2abfce2be8b46dd9826d597d94edeefc1570b4a992622721b90a1850e3ee9",
  schemaElevenRows: "52e25974ee4cd6f38459e1c2062f8b99cf9723f47529c102025b527b42422411",
  schemaTwelveRows: "262d216a76924895b1a32f697ace6ca247725330e546b63949d5cb7e8d4aec90",
});

export interface ExpectedHistoricalRevision {
  readonly id: string;
  readonly version: number;
  readonly parentRevisionId: string | null;
  readonly documentJson: string;
  readonly operationsJson: string;
  readonly snapshotHash: string;
  readonly operationHash: string;
  readonly parentRevisionHash: string | null;
  readonly revisionHash: string;
  readonly createdAt: string;
}

export interface HistoricalFixtureEvidence {
  readonly schemaVersion: HistoricalFixtureVersion;
  readonly schemaFingerprint: string;
  readonly designId: string;
  readonly currentRevisionId: string;
  readonly frameId: string;
  readonly pageId: string;
  readonly organizationId: string | null;
  readonly revisions: readonly ExpectedHistoricalRevision[];
  readonly asset: {
    readonly id: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  };
  readonly productSpecificationHash: string | null;
  readonly schemaElevenPreservationFingerprint: string | null;
  readonly schemaTwelvePreservationFingerprint: string | null;
}

export interface HistoricalDatabaseFixture {
  readonly sqlite: Database.Database;
  readonly evidence: HistoricalFixtureEvidence;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMigrationSeedRows(sqlite: Database.Database, version: HistoricalFixtureVersion): void {
  if (version < 3) return;
  sqlite.prepare(
    "UPDATE organizations SET name = 'Historical FormaSpec workspace', created_at = ?, updated_at = ? WHERE id = ?",
  ).run(CREATED_AT, CREATED_AT, ORGANIZATION_ID);
  sqlite.prepare(
    "UPDATE principals SET display_name = 'Historical local administrator', created_at = ? WHERE id = ?",
  ).run(CREATED_AT, PRINCIPAL_ID);
  sqlite.prepare(
    "UPDATE memberships SET created_at = ? WHERE organization_id = ? AND principal_id = ?",
  ).run(CREATED_AT, ORGANIZATION_ID, PRINCIPAL_ID);
}

function writeHistoricalVersionMetadata(sqlite: Database.Database, version: HistoricalFixtureVersion): void {
  if (version < 2) return;
  const values: Record<string, string> = {
    database_schema_version: String(version),
    command_engine_version: HISTORICAL_RUNTIME_VERSIONS.commandEngine,
    renderer_version: HISTORICAL_RUNTIME_VERSIONS.renderer,
    font_bundle_version: HISTORICAL_RUNTIME_VERSIONS.fontBundle,
    application_build_version: HISTORICAL_RUNTIME_VERSIONS.application,
    export_format_version: HISTORICAL_RUNTIME_VERSIONS.exportFormat,
  };
  const insert = sqlite.prepare(
    `INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  for (const [key, value] of Object.entries(values)) insert.run(key, value, CREATED_AT);
}

function fixtureDocuments(): {
  documentOne: DesignDocument;
  documentTwo: DesignDocument;
  operations: DesignOperation[];
  frameId: string;
  pageId: string;
  assetSha256: string;
} {
  const idFactory = createSequentialIdFactory("historical");
  const starter = createStarterDocument({
    id: DESIGN_ID as DesignDocument["id"],
    name: "Historical checkout",
    preset: "phone",
    now: CREATED_AT,
    idFactory,
  });
  const frameId = starter.pages[0]?.children[0];
  const pageId = starter.pages[0]?.id;
  if (!frameId || !pageId) throw new Error("Historical fixture starter did not contain a frame and page.");
  const documentOne = DesignDocumentSchema.parse({
    ...starter,
    revision: 1,
    metadata: { fixture: "historical-v1", source_schema: 1 },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  const assetSha256 = sha256(ONE_PIXEL_PNG);
  const operations = DesignOperationListSchema.parse([
    {
      operation_id: "operation_historical_fixture0001",
      type: "update_node",
      node_id: frameId,
      patch: {
        name: "Historical checkout frame",
        metadata: { migrated_fixture: true },
        metadata_mode: "merge",
      },
    },
    {
      operation_id: "operation_historical_fixture0002",
      type: "upsert_asset",
      asset: {
        id: ASSET_ID,
        name: "historical-pixel.png",
        kind: "image",
        mime_type: "image/png",
        size_bytes: ONE_PIXEL_PNG.length,
        storage_key: `legacy/${ASSET_ID}`,
        sha256: assetSha256,
        width: 1,
        height: 1,
        metadata: { fixture: "historical-v1" },
      },
    },
  ]);
  const documentTwo = applyDesignOperations(documentOne, operations, {
    expectedRevision: 1,
    now: UPDATED_AT,
  }).document;
  return { documentOne, documentTwo, operations, frameId, pageId, assetSha256 };
}

function expectedRevisions(
  documentOne: DesignDocument,
  documentTwo: DesignDocument,
  operations: readonly DesignOperation[],
): readonly ExpectedHistoricalRevision[] {
  const snapshotOne = canonicalSnapshot(documentOne);
  const snapshotTwo = canonicalSnapshot(documentTwo);
  const operationHashOne = operationHash([]);
  const operationHashTwo = operationHash(operations);
  const revisionHashOne = revisionHash({
    parentRevisionHash: null,
    snapshotHash: snapshotOne.hash,
    operationHash: operationHashOne,
    metadata: {
      id: REVISION_ONE_ID,
      designId: DESIGN_ID,
      version: 1,
      parentRevisionId: null,
      actorId: MIGRATION_ACTOR,
      message: "Create historical design",
      createdAt: CREATED_AT,
    },
  });
  const revisionHashTwo = revisionHash({
    parentRevisionHash: revisionHashOne,
    snapshotHash: snapshotTwo.hash,
    operationHash: operationHashTwo,
    metadata: {
      id: REVISION_TWO_ID,
      designId: DESIGN_ID,
      version: 2,
      parentRevisionId: REVISION_ONE_ID,
      actorId: MIGRATION_ACTOR,
      message: "Attach historical asset",
      createdAt: UPDATED_AT,
    },
  });
  return [
    {
      id: REVISION_ONE_ID,
      version: 1,
      parentRevisionId: null,
      documentJson: snapshotOne.canonicalJson,
      operationsJson: canonicalJson([]),
      snapshotHash: snapshotOne.hash,
      operationHash: operationHashOne,
      parentRevisionHash: null,
      revisionHash: revisionHashOne,
      createdAt: CREATED_AT,
    },
    {
      id: REVISION_TWO_ID,
      version: 2,
      parentRevisionId: REVISION_ONE_ID,
      documentJson: snapshotTwo.canonicalJson,
      operationsJson: canonicalJson(operations),
      snapshotHash: snapshotTwo.hash,
      operationHash: operationHashTwo,
      parentRevisionHash: revisionHashOne,
      revisionHash: revisionHashTwo,
      createdAt: UPDATED_AT,
    },
  ];
}

function insertDesignHistory(
  sqlite: Database.Database,
  version: HistoricalFixtureVersion,
  revisions: readonly ExpectedHistoricalRevision[],
  assetSha256: string,
): void {
  if (version >= 3) {
    sqlite.prepare(
      `INSERT INTO designs
       (id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
       VALUES (?, ?, 'Historical checkout', 2, ?, ?, ?, ?)`,
    ).run(DESIGN_ID, MIGRATION_ACTOR, REVISION_TWO_ID, CREATED_AT, UPDATED_AT, ORGANIZATION_ID);
  } else {
    sqlite.prepare(
      `INSERT INTO designs
       (id, actor_id, name, current_version, current_revision_id, created_at, updated_at)
       VALUES (?, ?, 'Historical checkout', 2, ?, ?, ?)`,
    ).run(DESIGN_ID, MIGRATION_ACTOR, REVISION_TWO_ID, CREATED_AT, UPDATED_AT);
  }

  for (const revision of revisions) {
    if (version >= 2) {
      storeSnapshot(sqlite, JSON.parse(revision.documentJson) as unknown, revision.createdAt);
      sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
          snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revision.id,
        DESIGN_ID,
        revision.version,
        revision.parentRevisionId,
        MIGRATION_ACTOR,
        revision.version === 1 ? "Create historical design" : "Attach historical asset",
        revision.documentJson,
        revision.operationsJson,
        revision.snapshotHash,
        revision.operationHash,
        revision.parentRevisionHash,
        revision.revisionHash,
        revision.createdAt,
      );
    } else {
      sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revision.id,
        DESIGN_ID,
        revision.version,
        revision.parentRevisionId,
        MIGRATION_ACTOR,
        revision.version === 1 ? "Create historical design" : "Attach historical asset",
        revision.documentJson,
        revision.operationsJson,
        revision.createdAt,
      );
    }
  }

  if (version >= 3) {
    sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at,
        organization_id)
       VALUES (?, ?, ?, 'historical-pixel.png', 'image/png', ?, 1, 1, ?, ?, ?, ?)`,
    ).run(
      ASSET_ID,
      MIGRATION_ACTOR,
      DESIGN_ID,
      ONE_PIXEL_PNG.length,
      assetSha256,
      ONE_PIXEL_PNG,
      UPDATED_AT,
      ORGANIZATION_ID,
    );
  } else {
    sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at)
       VALUES (?, ?, ?, 'historical-pixel.png', 'image/png', ?, 1, 1, ?, ?, ?)`,
    ).run(
      ASSET_ID,
      MIGRATION_ACTOR,
      DESIGN_ID,
      ONE_PIXEL_PNG.length,
      assetSha256,
      ONE_PIXEL_PNG,
      UPDATED_AT,
    );
  }
}

function insertProductSpecification(sqlite: Database.Database): { json: string; hash: string } {
  const specification = ProductSpecificationSchema.parse({
    id: PRODUCT_SPECIFICATION_ID,
    version: 1,
    natural_language_brief: "Preserve the historical checkout flow while upgrading FormaSpec.",
    summary: "Historical migration fixture",
    goals: [{
      id: "goal_historical_fixture0001",
      title: "Preserve history",
      description: "All immutable revisions and IDs survive migration.",
      links: {},
      success_measure: "Exact snapshot and revision hashes remain stable.",
    }],
  });
  const json = canonicalJson(specification);
  const hash = sha256(json);
  sqlite.prepare(
    `INSERT INTO product_specifications
     (design_id, version, specification_json, revision_id, actor_id, created_at,
      organization_id, specification_hash, message)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'Historical linked specification')`,
  ).run(
    DESIGN_ID,
    json,
    REVISION_TWO_ID,
    PRINCIPAL_ID,
    UPDATED_AT,
    ORGANIZATION_ID,
    hash,
  );
  return { json, hash };
}

function insertEnterpriseRows(
  sqlite: Database.Database,
  frameId: string,
  revision: ExpectedHistoricalRevision,
  productSpecificationHash: string,
): void {
  const token = DesignSystemTokenSchema.parse({
    id: DESIGN_SYSTEM_TOKEN_ID,
    path: "color.historical.primary",
    name: "Historical primary",
    family: "color",
    layer: "primitive",
    value: "#123456",
    deprecated: false,
  });
  const component = ComponentDefinitionSchema.parse({
    id: COMPONENT_DEFINITION_ID,
    key: "fixture.historicalCard",
    name: "Historical card",
    version: 1,
    status: "published",
    root_node_id: frameId,
    properties_schema: [],
    slots: [],
    states: [{ key: "default", name: "Default", node_id: frameId }],
    allowed_overrides: {
      allow_text: false,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: ["color"],
      allowed_style_paths: ["fill"],
    },
    platform_mappings: [{ platform: "web", framework: "React", symbol: "HistoricalCard" }],
    documentation: {
      summary: "Fixture component retained through schema migration.",
      usage: ["Historical fixture only"],
      accessibility: [],
      do_list: [],
      dont_list: [],
    },
  });
  const release = DesignSystemReleaseSchema.parse({
    id: DESIGN_SYSTEM_RELEASE_ID,
    design_system_id: DESIGN_SYSTEM_ID,
    version: 1,
    name: "Historical release 1",
    status: "published",
    token_ids: [token.id],
    component_versions: [{ component_definition_id: component.id, version: 1 }],
    created_at: CREATED_AT,
    published_at: UPDATED_AT,
  });
  sqlite.prepare(
    `INSERT INTO design_systems
     (id, organization_id, name, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, 'Historical system', 'Migration fixture', 'active', ?, ?, ?)`,
  ).run(DESIGN_SYSTEM_ID, ORGANIZATION_ID, PRINCIPAL_ID, CREATED_AT, UPDATED_AT);
  sqlite.prepare(
    `INSERT INTO design_system_tokens
     (design_system_id, token_id, version, status, token_json, created_by, created_at)
     VALUES (?, ?, 1, 'published', ?, ?, ?)`,
  ).run(DESIGN_SYSTEM_ID, token.id, canonicalJson(token), PRINCIPAL_ID, CREATED_AT);
  sqlite.prepare(
    `INSERT INTO component_definitions
     (design_system_id, component_id, version, status, definition_json, replacement_component_id,
      created_by, created_at)
     VALUES (?, ?, 1, 'published', ?, NULL, ?, ?)`,
  ).run(DESIGN_SYSTEM_ID, component.id, canonicalJson(component), PRINCIPAL_ID, CREATED_AT);
  sqlite.prepare(
    `INSERT INTO design_system_releases
     (id, design_system_id, version, name, status, release_json, created_by, created_at, published_at)
     VALUES (?, ?, 1, 'Historical release 1', 'published', ?, ?, ?, ?)`,
  ).run(
    DESIGN_SYSTEM_RELEASE_ID,
    DESIGN_SYSTEM_ID,
    canonicalJson({
      format: "formaspec-design-system-release",
      format_version: 1,
      release,
      token_versions: [{ token_id: token.id, version: 1 }],
      component_versions: [{ component_definition_id: component.id, version: 1 }],
      diagnostics: [],
    }),
    PRINCIPAL_ID,
    CREATED_AT,
    UPDATED_AT,
  );
  sqlite.prepare(
    `INSERT INTO project_design_system_pins
     (design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    DESIGN_ID,
    ORGANIZATION_ID,
    DESIGN_SYSTEM_ID,
    DESIGN_SYSTEM_RELEASE_ID,
    PRINCIPAL_ID,
    UPDATED_AT,
  );

  const inventory = UploadRepositoryInventorySchema.parse({
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: UPDATED_AT,
    platforms: ["web"],
    gitHead: "b".repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 4,
    skippedFileCount: 1,
    bytesRead: 4096,
    truncated: false,
    entities: [{
      id: INVENTORY_ENTITY_ID,
      kind: "screen",
      name: "HistoricalCheckout",
      symbol: "HistoricalCheckout",
      locationId: INVENTORY_LOCATION_ID,
      line: 12,
    }],
    excluded: [{ category: "secret", count: 1 }],
  });
  const inventoryJson = canonicalJson(inventory);
  const inventoryHash = hashPayload(inventory);
  sqlite.prepare(
    `INSERT INTO repository_inventories
     (id, organization_id, repository_fingerprint, inventory_hash, inventory_json,
      status, created_by, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
  ).run(
    INVENTORY_ID,
    ORGANIZATION_ID,
    inventory.repositoryFingerprint,
    inventoryHash,
    inventoryJson,
    PRINCIPAL_ID,
    UPDATED_AT,
  );

  const mappingJson = canonicalJson({
    schemaVersion: 1,
    designPin: {
      designId: DESIGN_ID,
      revisionId: revision.id,
      designVersion: revision.version,
      snapshotHash: revision.snapshotHash,
      revisionHash: revision.revisionHash,
    },
    productSpecificationPin: {
      source: "revision_link",
      version: 1,
      hash: productSpecificationHash,
    },
    inventoryPin: {
      inventoryId: INVENTORY_ID,
      inventoryHash,
      repositoryFingerprint: inventory.repositoryFingerprint,
      platform: "web",
    },
    designEntity: { kind: "screen", id: frameId },
    sourceEntity: {
      id: INVENTORY_ENTITY_ID,
      kind: "screen",
      symbol: "HistoricalCheckout",
      locationId: INVENTORY_LOCATION_ID,
      line: 12,
    },
  });
  sqlite.prepare(
    `INSERT INTO implementation_mappings
     (id, organization_id, design_id, revision_id, inventory_id, entity_kind, entity_id,
      platform, symbol, mapping_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'screen', ?, 'web', 'HistoricalCheckout', ?, ?, ?)`,
  ).run(
    MAPPING_ID,
    ORGANIZATION_ID,
    DESIGN_ID,
    revision.id,
    INVENTORY_ID,
    frameId,
    mappingJson,
    PRINCIPAL_ID,
    UPDATED_AT,
  );

  const handoff = HandoffSpecificationSchema.parse({
    schemaVersion: 1,
    title: "Historical checkout handoff",
    summary: "Pinned migration evidence.",
    acceptanceCriteria: [{
      id: "criterion_historical_fixture",
      statement: "The historical checkout remains inspectable.",
      designEntityIds: [frameId],
    }],
    implementationSlices: [{
      id: "slice_historical_fixture",
      title: "Preserve checkout",
      objective: "Retain stable IDs and immutable revision evidence.",
      inventoryEntityIds: [INVENTORY_ENTITY_ID],
      designEntityIds: [frameId],
      dependsOn: [],
      validationChecks: ["unit_tests", "build"],
    }],
    risks: ["Fixture drift"],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
  });
  sqlite.prepare(
    `INSERT INTO handoffs
     (id, organization_id, design_id, revision_id, inventory_id, status, current_version,
      created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'approved', 1, ?, ?, ?)`,
  ).run(
    HANDOFF_ID,
    ORGANIZATION_ID,
    DESIGN_ID,
    revision.id,
    INVENTORY_ID,
    PRINCIPAL_ID,
    CREATED_AT,
    UPDATED_AT,
  );
  sqlite.prepare(
    `INSERT INTO handoff_versions
     (handoff_id, version, specification_json, actor_id, created_at)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(HANDOFF_ID, canonicalJson(handoff), PRINCIPAL_ID, CREATED_AT);
  const transition = sqlite.prepare(
    `INSERT INTO handoff_transitions
     (id, handoff_id, from_status, to_status, actor_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  transition.run(
    `transition_${"7".repeat(32)}`,
    HANDOFF_ID,
    null,
    "draft",
    PRINCIPAL_ID,
    canonicalJson({ action: "create" }),
    CREATED_AT,
  );
  transition.run(
    `transition_${"8".repeat(32)}`,
    HANDOFF_ID,
    "draft",
    "in_review",
    PRINCIPAL_ID,
    canonicalJson({ action: "submit_review" }),
    "2025-01-10T09:10:00.000Z",
  );
  transition.run(
    `transition_${"9".repeat(32)}`,
    HANDOFF_ID,
    "in_review",
    "approved",
    PRINCIPAL_ID,
    canonicalJson({ action: "approve" }),
    UPDATED_AT,
  );
}

function insertRenderJob(sqlite: Database.Database): void {
  sqlite.prepare(
    `INSERT INTO render_jobs
     (id, organization_id, design_id, revision_id, document_id, document_revision,
      scope_kind, operation, kind, status, owner_id, request_hash, request_metadata_json,
      renderer_version, renderer_ipc_protocol_version, raster_normalizer_version,
      output_sha256, output_bytes, output_width, output_height, output_renderer, warnings_json,
      error_code, error_message, retryable, created_at, started_at, completed_at,
      heartbeat_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, 2, 'organization', 'historical_fixture', 'render', 'queued',
      ?, ?, '{}', ?, 1, 'raster-v1', NULL, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL,
      ?, NULL, NULL, ?, ?)`,
  ).run(
    RENDER_JOB_ID,
    ORGANIZATION_ID,
    DESIGN_ID,
    REVISION_TWO_ID,
    DESIGN_ID,
    `render_owner_${"a".repeat(32)}`,
    "b".repeat(64),
    HISTORICAL_RUNTIME_VERSIONS.renderer,
    UPDATED_AT,
    UPDATED_AT,
    "2025-01-10T09:20:00.000Z",
  );
}

function insertSchemaTwelveRows(sqlite: Database.Database): void {
  sqlite.prepare(
    `INSERT INTO handoff_execution_decisions
     (id, handoff_id, handoff_version, sequence, kind, outcome, supersedes_decision_id,
      evidence_json, evidence_hash, actor_id, created_at)
     VALUES (?, ?, 1, 1, 'plan_approval', 'approved', NULL, '{}', ?, ?, ?)`,
  ).run(HANDOFF_DECISION_ID, HANDOFF_ID, sha256("{}"), PRINCIPAL_ID, UPDATED_AT);
  sqlite.prepare(
    `INSERT INTO design_system_upgrade_previews
     (id, organization_id, design_id, current_release_id, target_release_id,
      diagnostics_json, preview_hash, status, created_by, created_at, expires_at, committed_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'ready', ?, ?, '2025-01-10T10:15:00.000Z', NULL)`,
  ).run(
    UPGRADE_PREVIEW_ID,
    ORGANIZATION_ID,
    DESIGN_ID,
    DESIGN_SYSTEM_RELEASE_ID,
    DESIGN_SYSTEM_RELEASE_ID,
    "e".repeat(64),
    PRINCIPAL_ID,
    UPDATED_AT,
  );
}

function schemaFingerprint(sqlite: Database.Database): string {
  const rows = sqlite.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
     ORDER BY type, name`,
  ).all();
  return hashPayload(rows);
}

function rowWithBlobDigests(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    Buffer.isBuffer(value) ? { bytes: value.length, sha256: sha256(value) } : value,
  ]));
}

export function schemaElevenPreservationFingerprint(sqlite: Database.Database): string {
  const queries = [
    "SELECT * FROM designs WHERE id = ?",
    "SELECT * FROM revisions WHERE design_id = ? ORDER BY version",
    "SELECT * FROM snapshots ORDER BY snapshot_hash",
    "SELECT * FROM assets WHERE design_id = ? ORDER BY id",
    "SELECT * FROM product_specifications WHERE design_id = ? ORDER BY version",
    "SELECT * FROM design_systems WHERE id = ?",
    "SELECT * FROM design_system_tokens WHERE design_system_id = ? ORDER BY token_id, version",
    `SELECT design_system_id, component_id, version, status, definition_json,
            replacement_component_id, created_by, created_at
     FROM component_definitions WHERE design_system_id = ? ORDER BY component_id, version`,
    "SELECT * FROM design_system_releases WHERE design_system_id = ? ORDER BY version",
    "SELECT * FROM project_design_system_pins WHERE design_id = ?",
    "SELECT * FROM repository_inventories WHERE id = ?",
    "SELECT * FROM implementation_mappings WHERE id = ?",
    "SELECT * FROM handoffs WHERE id = ?",
    "SELECT * FROM handoff_versions WHERE handoff_id = ? ORDER BY version",
    "SELECT * FROM handoff_transitions WHERE handoff_id = ? ORDER BY created_at, id",
    "SELECT * FROM render_jobs WHERE id = ?",
  ] as const;
  const parameters = [
    DESIGN_ID,
    DESIGN_ID,
    undefined,
    DESIGN_ID,
    DESIGN_ID,
    DESIGN_SYSTEM_ID,
    DESIGN_SYSTEM_ID,
    DESIGN_SYSTEM_ID,
    DESIGN_SYSTEM_ID,
    DESIGN_ID,
    INVENTORY_ID,
    MAPPING_ID,
    HANDOFF_ID,
    HANDOFF_ID,
    HANDOFF_ID,
    RENDER_JOB_ID,
  ] as const;
  const result = queries.map((query, index) => {
    const parameter = parameters[index];
    const statement = sqlite.prepare(query);
    const rows = parameter === undefined ? statement.all() : statement.all(parameter);
    return rows.map((row) => rowWithBlobDigests(row as Record<string, unknown>));
  });
  return hashPayload(result);
}

export function schemaTwelvePreservationFingerprint(sqlite: Database.Database): string {
  return hashPayload({
    schemaElevenRows: schemaElevenPreservationFingerprint(sqlite),
    handoffExecutionDecisions: (sqlite.prepare(
      "SELECT * FROM handoff_execution_decisions ORDER BY handoff_id, sequence",
    ).all() as Array<Record<string, unknown>>).map(rowWithBlobDigests),
    designSystemUpgradePreviews: (sqlite.prepare(
      `SELECT id, organization_id, design_id, current_release_id, target_release_id,
              diagnostics_json, preview_hash, status, created_by, created_at, expires_at, committed_at
       FROM design_system_upgrade_previews ORDER BY id`,
    ).all() as Array<Record<string, unknown>>).map(rowWithBlobDigests),
  });
}

export function createHistoricalDatabaseFixture(
  filename: string,
  version: HistoricalFixtureVersion,
): HistoricalDatabaseFixture {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    applyDatabaseMigrationPrefixForTesting(sqlite, version);
    normalizeMigrationSeedRows(sqlite, version);
    writeHistoricalVersionMetadata(sqlite, version);

    const documents = fixtureDocuments();
    const revisions = expectedRevisions(documents.documentOne, documents.documentTwo, documents.operations);
    insertDesignHistory(sqlite, version, revisions, documents.assetSha256);

    let productSpecificationHash: string | null = null;
    if (version >= 7) {
      productSpecificationHash = insertProductSpecification(sqlite).hash;
    }
    if (version >= 8) {
      insertEnterpriseRows(sqlite, documents.frameId, revisions[1]!, productSpecificationHash!);
    }
    if (version >= 11) insertRenderJob(sqlite);
    if (version >= 12) insertSchemaTwelveRows(sqlite);

    const evidence: HistoricalFixtureEvidence = {
      schemaVersion: version,
      schemaFingerprint: schemaFingerprint(sqlite),
      designId: DESIGN_ID,
      currentRevisionId: REVISION_TWO_ID,
      frameId: documents.frameId,
      pageId: documents.pageId,
      organizationId: version >= 3 ? ORGANIZATION_ID : null,
      revisions,
      asset: {
        id: ASSET_ID,
        sha256: documents.assetSha256,
        bytes: Buffer.from(ONE_PIXEL_PNG),
      },
      productSpecificationHash,
      schemaElevenPreservationFingerprint: version === 11
        ? schemaElevenPreservationFingerprint(sqlite)
        : null,
      schemaTwelvePreservationFingerprint: version === 12
        ? schemaTwelvePreservationFingerprint(sqlite)
        : null,
    };
    return { sqlite, evidence };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
