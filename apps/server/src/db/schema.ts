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
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("revisions_design_version").on(table.designId, table.version)]);

export const previews = sqliteTable("previews", {
  id: text("id").primaryKey(),
  designId: text("design_id").notNull(),
  actorId: text("actor_id").notNull(),
  rootBaseVersion: integer("root_base_version").notNull(),
  basePreviewId: text("base_preview_id"),
  operationHash: text("operation_hash").notNull(),
  operationsJson: text("operations_json").notNull(),
  documentJson: text("document_json").notNull(),
  diagnosticsJson: text("diagnostics_json").notNull(),
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
