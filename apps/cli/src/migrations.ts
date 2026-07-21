import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { resolveRuntimePaths } from "./runtime-paths.js";

export interface MigrationStatus {
  databasePath: string;
  latestAppliedVersion: number;
  supportedVersion: number;
  state: "current" | "behind" | "newer";
  migrations: Array<{ version: number; name: string; appliedAt: string }>;
}

export const CLI_SUPPORTED_DATABASE_VERSION = 14;

export function defaultDatabasePath(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveRuntimePaths(projectRoot, environment).dataDirectory, "designer.sqlite");
}

export function readMigrationStatus(databasePath: string): MigrationStatus {
  const resolved = path.resolve(databasePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Database path must be a regular file.");
  const sqlite = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("query_only = ON");
    const table = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (table === undefined) throw new Error("Database has no schema_migrations ledger.");
    const rows = sqlite.prepare(
      "SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number; name: string; appliedAt: string }>;
    let expected = 1;
    for (const row of rows) {
      if (row.version !== expected || typeof row.name !== "string" || typeof row.appliedAt !== "string") {
        throw new Error("Migration ledger is not a valid contiguous sequence.");
      }
      expected += 1;
    }
    const latestAppliedVersion = rows.at(-1)?.version ?? 0;
    return {
      databasePath: resolved,
      latestAppliedVersion,
      supportedVersion: CLI_SUPPORTED_DATABASE_VERSION,
      state: latestAppliedVersion === CLI_SUPPORTED_DATABASE_VERSION
        ? "current"
        : latestAppliedVersion < CLI_SUPPORTED_DATABASE_VERSION ? "behind" : "newer",
      migrations: rows,
    };
  } finally {
    sqlite.close();
  }
}
