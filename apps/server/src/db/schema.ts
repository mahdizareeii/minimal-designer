import { blob, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const designs = sqliteTable("designs", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull(),
  currentRevisionId: text("current_revision_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const revisions = sqliteTable("revisions", {
  id: text("id").primaryKey(),
  designId: text("design_id").notNull(),
  version: integer("version").notNull(),
  parentRevisionId: text("parent_revision_id"),
  actorId: text("actor_id").notNull(),
  message: text("message"),
  documentJson: text("document_json").notNull(),
  operationsJson: text("operations_json").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  operationHash: text("operation_hash").notNull(),
  parentRevisionHash: text("parent_revision_hash"),
  revisionHash: text("revision_hash").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("revisions_design_version").on(table.designId, table.version)]);

export const previews = sqliteTable("previews", {
  id: text("id").primaryKey(),
  designId: text("design_id").notNull(),
  actorId: text("actor_id").notNull(),
  rootBaseVersion: integer("root_base_version").notNull(),
  baseRevisionId: text("base_revision_id").notNull(),
  baseSnapshotHash: text("base_snapshot_hash").notNull(),
  basePreviewId: text("base_preview_id"),
  operationHash: text("operation_hash").notNull(),
  operationsJson: text("operations_json").notNull(),
  documentJson: text("document_json").notNull(),
  resultSnapshotHash: text("result_snapshot_hash").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
  temporaryIdMapJson: text("temporary_id_map_json").notNull(),
  createdIdsJson: text("created_ids_json").notNull(),
  changedNodeIdsJson: text("changed_node_ids_json").notNull(),
  commandEngineVersion: text("command_engine_version").notNull(),
  rendererVersion: text("renderer_version").notNull(),
  fontBundleVersion: text("font_bundle_version").notNull(),
  status: text("status").notNull(),
  kind: text("kind").notNull(),
  committedRevisionId: text("committed_revision_id"),
  committedAt: text("committed_at"),
  committable: integer("committable", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const idempotency = sqliteTable("idempotency", {
  actorId: text("actor_id").notNull(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [primaryKey({ columns: [table.actorId, table.scope, table.key] })]);

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  designId: text("design_id"),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  sha256: text("sha256").notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const contexts = sqliteTable("contexts", {
  actorId: text("actor_id").primaryKey(),
  designId: text("design_id"),
  pageId: text("page_id"),
  selectionJson: text("selection_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const systemMetadata = sqliteTable("system_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const snapshots = sqliteTable("snapshots", {
  snapshotHash: text("snapshot_hash").primaryKey(),
  encoding: text("encoding").notNull(),
  documentBrotli: blob("document_brotli", { mode: "buffer" }).notNull(),
  uncompressedBytes: integer("uncompressed_bytes").notNull(),
  createdAt: text("created_at").notNull(),
});

export const eventOutbox = sqliteTable("event_outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: text("organization_id").notNull(),
  actorId: text("actor_id").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  workspace: integer("workspace", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  publishedAt: text("published_at"),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  externalId: text("external_id"),
  createdAt: text("created_at").notNull(),
  disabledAt: text("disabled_at"),
});

export const memberships = sqliteTable("memberships", {
  organizationId: text("organization_id").notNull(),
  principalId: text("principal_id").notNull(),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.principalId] })]);

export const agentGrants = sqliteTable("agent_grants", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  principalId: text("principal_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  scopesJson: text("scopes_json").notNull(),
  projectIdsJson: text("project_ids_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastUsedAt: text("last_used_at"),
});

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  organizationId: text("organization_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const auditRetentionPreviews = sqliteTable("audit_retention_previews", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  actorId: text("actor_id").notNull(),
  configurationHash: text("configuration_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  retentionDays: integer("retention_days").notNull(),
  cutoffAt: text("cutoff_at").notNull(),
  auditEventIdsJson: text("audit_event_ids_json").notNull(),
  auditEventCount: integer("audit_event_count").notNull(),
  auditEventBytes: integer("audit_event_bytes").notNull(),
  auditFirstId: integer("audit_first_id"),
  auditLastId: integer("audit_last_id"),
  auditEventsHash: text("audit_events_hash").notNull(),
  auditHasMore: integer("audit_has_more", { mode: "boolean" }).notNull(),
  outboxEventIdsJson: text("outbox_event_ids_json").notNull(),
  outboxEventCount: integer("outbox_event_count").notNull(),
  outboxEventBytes: integer("outbox_event_bytes").notNull(),
  outboxFirstId: integer("outbox_first_id"),
  outboxLastId: integer("outbox_last_id"),
  outboxEventsHash: text("outbox_events_hash").notNull(),
  outboxHasMore: integer("outbox_has_more", { mode: "boolean" }).notNull(),
  planHash: text("plan_hash").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  committedRunId: text("committed_run_id"),
  committedAt: text("committed_at"),
});

export const auditRetentionRuns = sqliteTable("audit_retention_runs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  previewId: text("preview_id").notNull(),
  actorId: text("actor_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  configurationHash: text("configuration_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  retentionDays: integer("retention_days").notNull(),
  cutoffAt: text("cutoff_at").notNull(),
  auditEventIdsJson: text("audit_event_ids_json").notNull(),
  auditEventCount: integer("audit_event_count").notNull(),
  auditEventBytes: integer("audit_event_bytes").notNull(),
  auditFirstId: integer("audit_first_id"),
  auditLastId: integer("audit_last_id"),
  auditEventsHash: text("audit_events_hash").notNull(),
  auditHasMore: integer("audit_has_more", { mode: "boolean" }).notNull(),
  outboxEventIdsJson: text("outbox_event_ids_json").notNull(),
  outboxEventCount: integer("outbox_event_count").notNull(),
  outboxEventBytes: integer("outbox_event_bytes").notNull(),
  outboxFirstId: integer("outbox_first_id"),
  outboxLastId: integer("outbox_last_id"),
  outboxEventsHash: text("outbox_events_hash").notNull(),
  outboxHasMore: integer("outbox_has_more", { mode: "boolean" }).notNull(),
  planHash: text("plan_hash").notNull(),
  previousRunHash: text("previous_run_hash"),
  runHash: text("run_hash").notNull(),
  commitAuditEventId: integer("commit_audit_event_id").notNull(),
  commitOutboxEventId: integer("commit_outbox_event_id").notNull(),
  completedAt: text("completed_at").notNull(),
});

export const auditRetentionDeletePermits = sqliteTable("audit_retention_delete_permits", {
  runId: text("run_id").notNull(),
  organizationId: text("organization_id").notNull(),
  eventKind: text("event_kind").notNull(),
  eventId: integer("event_id").notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.eventKind, table.eventId] })]);

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  actorId: text("actor_id").notNull(),
  brief: text("brief").notNull(),
  selectionJson: text("selection_json").notNull(),
  baseVersion: integer("base_version").notNull(),
  expectedOutput: text("expected_output").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const agentTaskTransitions = sqliteTable("agent_task_transitions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id").notNull(),
  message: text("message"),
  dataJson: text("data_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const planningSessions = sqliteTable("planning_sessions", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  currentSection: text("current_section").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const planningAnswers = sqliteTable("planning_answers", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  section: text("section").notNull(),
  version: integer("version").notNull(),
  answer: text("answer").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
});

export const planningSessionVersions = sqliteTable("planning_session_versions", {
  sessionId: text("session_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  currentSection: text("current_section").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.sessionId, table.version] })]);

export const productSpecifications = sqliteTable("product_specifications", {
  designId: text("design_id").notNull(),
  version: integer("version").notNull(),
  specificationJson: text("specification_json").notNull(),
  organizationId: text("organization_id").notNull(),
  specificationHash: text("specification_hash").notNull(),
  message: text("message"),
  revisionId: text("revision_id"),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.designId, table.version] })]);

export const productSpecPreviews = sqliteTable("product_spec_previews", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  actorId: text("actor_id").notNull(),
  baseVersion: integer("base_version").notNull(),
  specificationJson: text("specification_json").notNull(),
  specificationHash: text("specification_hash").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  committedVersion: integer("committed_version"),
  committedAt: text("committed_at"),
  commitActorId: text("commit_actor_id"),
});

export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  principalId: text("principal_id"),
  adapter: text("adapter").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  scopesJson: text("scopes_json").notNull(),
  projectIdsJson: text("project_ids_json").notNull(),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pairingNonces = sqliteTable("pairing_nonces", {
  nonceHash: text("nonce_hash").primaryKey(),
  connectionId: text("connection_id").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  revokedAt: text("revoked_at"),
});

export const backupRecords = sqliteTable("backup_records", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  filename: text("filename").notNull(),
  bundleSha256: text("bundle_sha256"),
  status: text("status").notNull(),
  manifestJson: text("manifest_json"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  verifiedAt: text("verified_at"),
  sizeBytes: integer("size_bytes"),
  verificationJson: text("verification_json"),
  retentionClass: text("retention_class").notNull(),
  completedAt: text("completed_at"),
});

export const backupSchedules = sqliteTable("backup_schedules", {
  organizationId: text("organization_id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  cronExpression: text("cron_expression").notNull(),
  dailyRetention: integer("daily_retention").notNull(),
  weeklyRetention: integer("weekly_retention").notNull(),
  monthlyRetention: integer("monthly_retention").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const portableExports = sqliteTable("portable_exports", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  revisionId: text("revision_id").notNull(),
  filename: text("filename").notNull(),
  bundleSha256: text("bundle_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  manifestJson: text("manifest_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const portableImports = sqliteTable("portable_imports", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  mode: text("mode").notNull(),
  bundleSha256: text("bundle_sha256").notNull(),
  sourceDocumentId: text("source_document_id").notNull(),
  sourceDocumentRevision: integer("source_document_revision").notNull(),
  sourceRevisionId: text("source_revision_id").notNull(),
  sourceRevisionHashClaim: text("source_revision_hash_claim").notNull(),
  targetDesignId: text("target_design_id").notNull(),
  targetRevisionId: text("target_revision_id").notNull(),
  idMapJson: text("id_map_json").notNull(),
  manifestJson: text("manifest_json").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const operationalLocks = sqliteTable("operational_locks", {
  name: text("name").notNull(),
  organizationId: text("organization_id").notNull(),
  holderId: text("holder_id").notNull(),
  purpose: text("purpose").notNull(),
  metadataJson: text("metadata_json").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [primaryKey({ columns: [table.organizationId, table.name] })]);

export const designSystems = sqliteTable("design_systems", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const designSystemTokens = sqliteTable("design_system_tokens", {
  designSystemId: text("design_system_id").notNull(),
  tokenId: text("token_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  tokenJson: text("token_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.designSystemId, table.tokenId, table.version] })]);

export const componentDefinitions = sqliteTable("component_definitions", {
  designSystemId: text("design_system_id").notNull(),
  componentId: text("component_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  definitionJson: text("definition_json").notNull(),
  replacementComponentId: text("replacement_component_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.designSystemId, table.componentId, table.version] })]);

export const designSystemReleases = sqliteTable("design_system_releases", {
  id: text("id").primaryKey(),
  designSystemId: text("design_system_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  releaseJson: text("release_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  publishedAt: text("published_at"),
}, (table) => [uniqueIndex("design_system_releases_system_version").on(table.designSystemId, table.version)]);

export const projectDesignSystemPins = sqliteTable("project_design_system_pins", {
  designId: text("design_id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designSystemId: text("design_system_id").notNull(),
  releaseId: text("release_id").notNull(),
  releaseVersion: integer("release_version").notNull(),
  pinnedBy: text("pinned_by").notNull(),
  pinnedAt: text("pinned_at").notNull(),
});

export const designSystemUpgradePreviews = sqliteTable("design_system_upgrade_previews", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  currentReleaseId: text("current_release_id"),
  targetReleaseId: text("target_release_id").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
  previewHash: text("preview_hash").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  committedAt: text("committed_at"),
});

export const repositoryInventories = sqliteTable("repository_inventories", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  repositoryFingerprint: text("repository_fingerprint").notNull(),
  inventoryHash: text("inventory_hash").notNull(),
  inventoryJson: text("inventory_json").notNull(),
  status: text("status").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [uniqueIndex("repository_inventories_org_fingerprint_hash").on(
  table.organizationId,
  table.repositoryFingerprint,
  table.inventoryHash,
)]);

export const implementationMappings = sqliteTable("implementation_mappings", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  revisionId: text("revision_id").notNull(),
  inventoryId: text("inventory_id"),
  entityKind: text("entity_kind").notNull(),
  entityId: text("entity_id").notNull(),
  platform: text("platform").notNull(),
  symbol: text("symbol").notNull(),
  mappingJson: text("mapping_json").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const handoffs = sqliteTable("handoffs", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id").notNull(),
  revisionId: text("revision_id").notNull(),
  inventoryId: text("inventory_id"),
  status: text("status").notNull(),
  currentVersion: integer("current_version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const handoffVersions = sqliteTable("handoff_versions", {
  handoffId: text("handoff_id").notNull(),
  version: integer("version").notNull(),
  specificationJson: text("specification_json").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.handoffId, table.version] })]);

export const handoffTransitions = sqliteTable("handoff_transitions", {
  id: text("id").primaryKey(),
  handoffId: text("handoff_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorId: text("actor_id").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const redesignAssessments = sqliteTable("redesign_assessments", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull(),
  designId: text("design_id"),
  inventoryId: text("inventory_id"),
  status: text("status").notNull(),
  currentStage: text("current_stage").notNull(),
  currentVersion: integer("current_version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const redesignAssessmentVersions = sqliteTable("redesign_assessment_versions", {
  assessmentId: text("assessment_id").notNull(),
  version: integer("version").notNull(),
  stage: text("stage").notNull(),
  contentJson: text("content_json").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.assessmentId, table.version] })]);

export const redesignTransitions = sqliteTable("redesign_transitions", {
  id: text("id").primaryKey(),
  assessmentId: text("assessment_id").notNull(),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  decision: text("decision").notNull(),
  actorId: text("actor_id").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
});
