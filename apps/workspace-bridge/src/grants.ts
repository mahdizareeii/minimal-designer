import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeExcludedPatterns } from "./inventory.js";

export const REPOSITORY_GRANT_SCHEMA_VERSION = 1 as const;

export interface RepositoryGrant {
  schemaVersion: typeof REPOSITORY_GRANT_SCHEMA_VERSION;
  id: string;
  repositoryRoot: string;
  repositoryFingerprint: string;
  excludedPatterns: string[];
  capabilities: ["inventory:read"];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface PublicRepositoryGrant {
  schemaVersion: typeof REPOSITORY_GRANT_SCHEMA_VERSION;
  id: string;
  repositoryFingerprint: string;
  excludedPatterns: string[];
  capabilities: ["inventory:read"];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
}

const GRANT_ID = /^repo_grant_[a-f0-9]{40}$/;

function canonicalGrantId(repositoryRoot: string, createdAt: string, nonce: string): string {
  return `repo_grant_${createHash("sha256").update(`${repositoryRoot}\0${createdAt}\0${nonce}`).digest("hex").slice(0, 40)}`;
}

function assertSafeStateDirectory(stateDirectory: string): void {
  const resolved = path.resolve(stateDirectory);
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing = fs.lstatSync(current);
  if (existing.isSymbolicLink()) throw new Error("Workspace Bridge state directory may not traverse a symbolic link.");
}

function parseGrant(value: unknown): RepositoryGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Repository grant is malformed.");
  const grant = value as Partial<RepositoryGrant>;
  if (grant.schemaVersion !== REPOSITORY_GRANT_SCHEMA_VERSION
    || typeof grant.id !== "string" || !GRANT_ID.test(grant.id)
    || typeof grant.repositoryRoot !== "string" || !path.isAbsolute(grant.repositoryRoot)
    || typeof grant.repositoryFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(grant.repositoryFingerprint)
    || !Array.isArray(grant.capabilities) || grant.capabilities.length !== 1 || grant.capabilities[0] !== "inventory:read"
    || typeof grant.createdAt !== "string" || !Number.isFinite(Date.parse(grant.createdAt))
    || typeof grant.expiresAt !== "string" || !Number.isFinite(Date.parse(grant.expiresAt))
    || (grant.revokedAt !== null && (typeof grant.revokedAt !== "string" || !Number.isFinite(Date.parse(grant.revokedAt))))) {
    throw new Error("Repository grant is malformed.");
  }
  let excludedPatterns: string[];
  try {
    excludedPatterns = normalizeExcludedPatterns(grant.excludedPatterns ?? []);
  } catch {
    throw new Error("Repository grant is malformed.");
  }
  return { ...(grant as Omit<RepositoryGrant, "excludedPatterns">), excludedPatterns };
}

export function publicRepositoryGrant(grant: RepositoryGrant, now = new Date()): PublicRepositoryGrant {
  return {
    schemaVersion: grant.schemaVersion,
    id: grant.id,
    repositoryFingerprint: grant.repositoryFingerprint,
    excludedPatterns: [...grant.excludedPatterns],
    capabilities: grant.capabilities,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    status: grant.revokedAt !== null ? "revoked" : Date.parse(grant.expiresAt) <= now.getTime() ? "expired" : "active",
  };
}

export class RepositoryGrantStore {
  readonly stateDirectory: string;

  constructor(stateDirectory = path.join(os.homedir(), ".formaspec", "workspace-bridge")) {
    this.stateDirectory = path.resolve(stateDirectory);
  }

  async create(
    repositoryRoot: string,
    repositoryFingerprint: string,
    options: { ttlSeconds?: number; now?: Date; excludedPatterns?: readonly string[] } = {},
  ): Promise<RepositoryGrant> {
    const root = await fs.promises.realpath(path.resolve(repositoryRoot));
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The selected repository must be a real directory.");
    if (!/^[a-f0-9]{64}$/.test(repositoryFingerprint)) throw new Error("Repository fingerprint is invalid.");
    const ttlSeconds = options.ttlSeconds ?? 24 * 60 * 60;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 24 * 60 * 60) {
      throw new Error("Repository grant lifetime must be between 60 seconds and 30 days.");
    }
    const now = options.now ?? new Date();
    const createdAt = now.toISOString();
    const excludedPatterns = normalizeExcludedPatterns(options.excludedPatterns ?? []);
    const grant: RepositoryGrant = {
      schemaVersion: REPOSITORY_GRANT_SCHEMA_VERSION,
      id: canonicalGrantId(root, createdAt, randomUUID()),
      repositoryRoot: root,
      repositoryFingerprint,
      excludedPatterns,
      capabilities: ["inventory:read"],
      createdAt,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
      revokedAt: null,
    };
    await this.write(grant);
    return grant;
  }

  async list(): Promise<RepositoryGrant[]> {
    if (!fs.existsSync(this.stateDirectory)) return [];
    const entries = await fs.promises.readdir(this.stateDirectory, { withFileTypes: true });
    const grants: RepositoryGrant[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !GRANT_ID.test(entry.name.replace(/\.json$/, "")) || !entry.name.endsWith(".json")) continue;
      grants.push(await this.read(entry.name.slice(0, -5)));
    }
    return grants;
  }

  async read(grantId: string): Promise<RepositoryGrant> {
    if (!GRANT_ID.test(grantId)) throw new Error("Repository grant was not found.");
    const filename = path.join(this.stateDirectory, `${grantId}.json`);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Repository grant was not found.");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Repository grant storage is unsafe.");
    return parseGrant(JSON.parse(await fs.promises.readFile(filename, "utf8")) as unknown);
  }

  async requireActive(grantId: string, now = new Date()): Promise<RepositoryGrant> {
    const grant = await this.read(grantId);
    const status = publicRepositoryGrant(grant, now).status;
    if (status !== "active") throw new Error(`Repository grant is ${status}.`);
    const currentRoot = await fs.promises.realpath(grant.repositoryRoot);
    if (currentRoot !== grant.repositoryRoot) throw new Error("Repository grant root no longer resolves to the authorized directory.");
    return grant;
  }

  async revoke(grantId: string, now = new Date()): Promise<RepositoryGrant> {
    const grant = await this.read(grantId);
    if (grant.revokedAt !== null) return grant;
    const revoked = { ...grant, revokedAt: now.toISOString() };
    await this.write(revoked);
    return revoked;
  }

  private async write(grant: RepositoryGrant): Promise<void> {
    assertSafeStateDirectory(this.stateDirectory);
    await fs.promises.mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.stateDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Workspace Bridge state directory is unsafe.");
    const destination = path.join(this.stateDirectory, `${grant.id}.json`);
    const temporary = path.join(this.stateDirectory, `.${grant.id}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, `${JSON.stringify(grant, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.promises.rename(temporary, destination);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }
}
