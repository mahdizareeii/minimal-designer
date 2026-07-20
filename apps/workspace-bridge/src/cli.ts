#!/usr/bin/env node
import path from "node:path";

import { RepositoryGrantStore, publicRepositoryGrant } from "./grants.js";
import { inventoryForUpload, scanRepository } from "./inventory.js";
import {
  assertInventoryMatchesPolicy,
  persistRepositoryInventory,
  readRepositoryScanPolicy,
  repositoryPolicyConnectionFromEnvironment,
  type RepositoryPolicyConnection,
  type RepositoryScanPolicy,
} from "./policy.js";

function usage(): string {
  return `FormaSpec Workspace Bridge

Usage:
  formaspec-workspace-bridge grant <repository> [--ttl-seconds <seconds>] [--exclude-pattern <glob>]...
  formaspec-workspace-bridge inspect <grant-id> [--local-paths]
  formaspec-workspace-bridge list
  formaspec-workspace-bridge revoke <grant-id>

The default inspect output is safe to upload and contains opaque location IDs,
not repository paths. --local-paths is for workstation-only diagnostics.
Organization repository exclusions must be supplied as repeated
--exclude-pattern values when no FormaSpec API connection is configured.
Set FORMASPEC_API_URL (and FORMASPEC_API_TOKEN for token-authenticated API
mode), or point FORMASPEC_UPSTREAM_MCP_URL at the authorized local bridge, to
load and enforce the current organization policy and persist the path-free
inventory automatically.`;
}

function samePatterns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((pattern, index) => pattern === right[index]);
}

async function connectedRepositoryPolicy(): Promise<{
  connection: RepositoryPolicyConnection;
  policy: RepositoryScanPolicy;
} | null> {
  const connection = repositoryPolicyConnectionFromEnvironment(process.env);
  return connection === null ? null : { connection, policy: await readRepositoryScanPolicy(connection) };
}

async function main(arguments_: string[]): Promise<number> {
  const store = new RepositoryGrantStore(process.env.FORMASPEC_WORKSPACE_BRIDGE_STATE);
  const command = arguments_.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "grant") {
    const repository = arguments_.shift();
    if (!repository) throw new Error("grant requires an explicitly selected repository path.");
    let ttlSeconds: number | undefined;
    const excludedPatterns: string[] = [];
    while (arguments_.length > 0) {
      const option = arguments_.shift();
      if (option === "--ttl-seconds") {
        if (ttlSeconds !== undefined) throw new Error("--ttl-seconds may be supplied only once.");
        ttlSeconds = Number(arguments_.shift());
        continue;
      }
      if (option === "--exclude-pattern") {
        const pattern = arguments_.shift();
        if (pattern === undefined) throw new Error("--exclude-pattern requires a glob value.");
        excludedPatterns.push(pattern);
        continue;
      }
      throw new Error(`Unexpected grant option: ${option}`);
    }
    const connected = await connectedRepositoryPolicy();
    const policy = connected?.policy ?? null;
    if (policy !== null && excludedPatterns.length > 0 && !samePatterns(excludedPatterns, policy.excludedPatterns)) {
      throw new Error("Manual exclusion patterns do not match the connected FormaSpec organization policy.");
    }
    const effectivePatterns = policy?.excludedPatterns ?? excludedPatterns;
    const inventory = await scanRepository(path.resolve(repository), {
      excludedPatterns: effectivePatterns,
      ...(policy === null ? {} : { limits: { maximumEntities: policy.maximumInventoryEntities } }),
    });
    if (policy !== null) assertInventoryMatchesPolicy(inventory, policy);
    const grant = await store.create(repository, inventory.repositoryFingerprint, {
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      excludedPatterns: inventory.excludedPatterns,
    });
    const upload = inventoryForUpload(inventory);
    const persisted = connected === null
      ? null
      : await persistRepositoryInventory(connected.connection, upload);
    process.stdout.write(`${JSON.stringify({
      grant: publicRepositoryGrant(grant),
      inventory: upload,
      ...(persisted === null ? {} : { persistedInventory: persisted }),
    })}\n`);
    return 0;
  }
  if (command === "inspect") {
    const grantId = arguments_.shift();
    if (!grantId) throw new Error("inspect requires a repository grant ID.");
    const localPaths = arguments_.shift() === "--local-paths";
    if (arguments_.length > 0) throw new Error(`Unexpected inspect option: ${arguments_[0]}`);
    const grant = await store.requireActive(grantId);
    const connected = await connectedRepositoryPolicy();
    const policy = connected?.policy ?? null;
    if (policy !== null && !samePatterns(grant.excludedPatterns, policy.excludedPatterns)) {
      throw new Error("Organization repository exclusions changed after authorization; create a new explicit grant.");
    }
    const inventory = await scanRepository(grant.repositoryRoot, { excludedPatterns: grant.excludedPatterns });
    if (inventory.repositoryFingerprint !== grant.repositoryFingerprint) {
      throw new Error("Repository contents changed after authorization; create a new explicit grant.");
    }
    if (policy !== null) assertInventoryMatchesPolicy(inventory, policy);
    process.stdout.write(`${JSON.stringify(localPaths ? inventory : inventoryForUpload(inventory))}\n`);
    return 0;
  }
  if (command === "list") {
    if (arguments_.length > 0) throw new Error(`Unexpected list option: ${arguments_[0]}`);
    process.stdout.write(`${JSON.stringify((await store.list()).map((grant) => publicRepositoryGrant(grant)))}\n`);
    return 0;
  }
  if (command === "revoke") {
    const grantId = arguments_.shift();
    if (!grantId || arguments_.length > 0) throw new Error("revoke requires exactly one repository grant ID.");
    process.stdout.write(`${JSON.stringify(publicRepositoryGrant(await store.revoke(grantId)))}\n`);
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

main(process.argv.slice(2)).then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
