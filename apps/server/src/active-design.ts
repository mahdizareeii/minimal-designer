import type Database from "better-sqlite3";

import { assertProjectAccess, type AccessContext } from "./authorization.js";
import { DomainError } from "./errors.js";

export interface ActiveDesignAccessRow {
  id: string;
  product_id: string;
  organization_id: string;
  current_version: number;
  current_revision_id: string;
}

export function designArchiveMetadataKey(designId: string): string {
  return `design_archive:${designId}`;
}

export function activeDesignSqlPredicate(alias = "designs"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Active-design SQL alias is invalid.");
  return `NOT EXISTS (
    SELECT 1 FROM system_metadata formaspec_archive
    WHERE formaspec_archive.key = 'design_archive:' || ${alias}.id
  )`;
}

export function isDesignArchived(sqlite: Database.Database, designId: string): boolean {
  return sqlite.prepare("SELECT 1 FROM system_metadata WHERE key = ?")
    .get(designArchiveMetadataKey(designId)) !== undefined;
}

export function requireActiveDesign(
  sqlite: Database.Database,
  access: AccessContext,
  designId: string,
): ActiveDesignAccessRow {
  const row = sqlite.prepare(
    `SELECT id, product_id, organization_id, current_version, current_revision_id
     FROM designs
     WHERE id = ? AND ${activeDesignSqlPredicate("designs")}`,
  ).get(designId) as ActiveDesignAccessRow | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "Design not found.", 404);
  assertProjectAccess(access, row.organization_id, row.id);
  return row;
}

export function assertDesignIsActive(
  sqlite: Database.Database,
  access: AccessContext,
  designId: string,
): void {
  requireActiveDesign(sqlite, access, designId);
}
