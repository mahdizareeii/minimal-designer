import type Database from "better-sqlite3";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

export const AGENT_CONNECTION_REPLACEMENT_PREFIX = "agent_connection_replacement:";

export interface AgentConnectionReplacementIntent {
  schema_version: 1;
  pending_connection_id: string;
  organization_id: string;
  replaced_connection_ids: string[];
  created_by: string;
  created_at: string;
}

function replacementKey(connectionId: string): string {
  return `${AGENT_CONNECTION_REPLACEMENT_PREFIX}${connectionId}`;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240;
}

function parseReplacementIntent(
  value: string,
  pendingConnectionId: string,
  organizationId: string,
): AgentConnectionReplacementIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Persisted agent connection replacement intent is invalid.", 500, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("INTERNAL_ERROR", "Persisted agent connection replacement intent is invalid.", 500);
  }
  const intent = parsed as Record<string, unknown>;
  const replacedConnectionIds = intent.replaced_connection_ids;
  if (intent.schema_version !== 1
    || intent.pending_connection_id !== pendingConnectionId
    || intent.organization_id !== organizationId
    || !Array.isArray(replacedConnectionIds)
    || replacedConnectionIds.length === 0
    || replacedConnectionIds.length > 100
    || !replacedConnectionIds.every(validIdentifier)
    || new Set(replacedConnectionIds).size !== replacedConnectionIds.length
    || replacedConnectionIds.includes(pendingConnectionId)
    || !validIdentifier(intent.created_by)
    || typeof intent.created_at !== "string"
    || Number.isNaN(Date.parse(intent.created_at))) {
    throw new DomainError("INTERNAL_ERROR", "Persisted agent connection replacement intent is invalid.", 500);
  }
  return intent as unknown as AgentConnectionReplacementIntent;
}

export function persistAgentConnectionReplacement(
  sqlite: Database.Database,
  input: Omit<AgentConnectionReplacementIntent, "schema_version">,
): void {
  const replacedConnectionIds = [...new Set(input.replaced_connection_ids)].sort();
  if (replacedConnectionIds.length === 0) return;
  const intent: AgentConnectionReplacementIntent = {
    schema_version: 1,
    ...input,
    replaced_connection_ids: replacedConnectionIds,
  };
  const serialized = canonicalJson(intent);
  const key = replacementKey(input.pending_connection_id);
  const existing = sqlite.prepare("SELECT value FROM system_metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (existing) {
    if (existing.value === serialized) return;
    throw new DomainError("INTERNAL_ERROR", "The pending agent connection has conflicting replacement intent.", 500);
  }
  sqlite.prepare("INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, serialized, input.created_at);
}

export function readAgentConnectionReplacement(
  sqlite: Database.Database,
  pendingConnectionId: string,
  organizationId: string,
): AgentConnectionReplacementIntent | null {
  const row = sqlite.prepare("SELECT value FROM system_metadata WHERE key = ?")
    .get(replacementKey(pendingConnectionId)) as { value: string } | undefined;
  return row ? parseReplacementIntent(row.value, pendingConnectionId, organizationId) : null;
}

export function consumeAgentConnectionReplacement(
  sqlite: Database.Database,
  intent: AgentConnectionReplacementIntent,
): void {
  const removed = sqlite.prepare("DELETE FROM system_metadata WHERE key = ? AND value = ?")
    .run(replacementKey(intent.pending_connection_id), canonicalJson(intent));
  if (removed.changes !== 1) {
    throw new DomainError("INTERNAL_ERROR", "The pending agent connection replacement intent changed unexpectedly.", 500);
  }
}

export function clearAgentConnectionReplacement(sqlite: Database.Database, pendingConnectionId: string): void {
  sqlite.prepare("DELETE FROM system_metadata WHERE key = ?").run(replacementKey(pendingConnectionId));
}
