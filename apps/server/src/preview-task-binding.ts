import type Database from "better-sqlite3";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

const PREVIEW_TASK_BINDING_PREFIX = "agent_task_preview_binding:";

interface PreviewTaskBinding {
  schema_version: 1;
  preview_id: string;
  task_id: string;
  created_at: string;
}

function bindingKey(previewId: string): string {
  return `${PREVIEW_TASK_BINDING_PREFIX}${previewId}`;
}

function parseBinding(value: string, previewId: string): PreviewTaskBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Persisted preview task binding is invalid.", 500, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("INTERNAL_ERROR", "Persisted preview task binding is invalid.", 500);
  }
  const binding = parsed as Record<string, unknown>;
  if (binding.schema_version !== 1
    || binding.preview_id !== previewId
    || typeof binding.task_id !== "string"
    || binding.task_id.length < 1
    || binding.task_id.length > 240
    || typeof binding.created_at !== "string"
    || Number.isNaN(Date.parse(binding.created_at))) {
    throw new DomainError("INTERNAL_ERROR", "Persisted preview task binding is invalid.", 500);
  }
  return binding as unknown as PreviewTaskBinding;
}

export function bindPreviewToTask(
  sqlite: Database.Database,
  previewId: string,
  taskId: string,
  createdAt: string,
): void {
  const binding: PreviewTaskBinding = {
    schema_version: 1,
    preview_id: previewId,
    task_id: taskId,
    created_at: createdAt,
  };
  const serialized = canonicalJson(binding);
  const existing = sqlite.prepare("SELECT value FROM system_metadata WHERE key = ?")
    .get(bindingKey(previewId)) as { value: string } | undefined;
  if (existing) {
    if (existing.value === serialized) return;
    throw new DomainError("IDEMPOTENCY_CONFLICT", "The preview is already bound to another task.", 409);
  }
  sqlite.prepare("INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)")
    .run(bindingKey(previewId), serialized, createdAt);
}

export function previewTaskId(sqlite: Database.Database, previewId: string): string | null {
  const row = sqlite.prepare("SELECT value FROM system_metadata WHERE key = ?")
    .get(bindingKey(previewId)) as { value: string } | undefined;
  return row ? parseBinding(row.value, previewId).task_id : null;
}

export function requirePreviewTaskBinding(
  sqlite: Database.Database,
  previewId: string,
  taskId: string,
): void {
  if (previewTaskId(sqlite, previewId) !== taskId) {
    throw new DomainError("NOT_FOUND", "Preview not found.", 404);
  }
}
