import {
  DesignOperationListSchema,
  DocumentIdSchema,
  type DesignOperation,
} from "@designer/core";

const CONFLICT_RECOVERY_KIND = "formaspec.conflict-recovery" as const;
const CONFLICT_PATCH_FORMAT = "formaspec.patch" as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_OPAQUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{7,191}$/;
const SAFE_ACTOR_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;
export const MAX_CONFLICT_RECOVERY_OPERATIONS = 500;
export const MAX_CONFLICT_RECOVERY_OPERATION_BYTES = 1_048_576;
const MAX_CONFLICT_PATCH_BYTES = MAX_CONFLICT_RECOVERY_OPERATION_BYTES + 16_384;

export interface ConflictRevisionIdentity {
  version: number;
  id?: string;
}

export interface ConflictLatestRevision {
  version?: number;
  id?: string;
  actor?: string;
  createdAt?: string;
}

export interface ConflictRecovery {
  kind: typeof CONFLICT_RECOVERY_KIND;
  schemaVersion: 1;
  design: { id: string };
  baseRevision: ConflictRevisionIdentity;
  latestRevision?: ConflictLatestRevision;
  operations: DesignOperation[];
  operationHash: string;
  createdAt: string;
}

export interface FormaSpecConflictPatchV1 {
  format: typeof CONFLICT_PATCH_FORMAT;
  schema_version: 1;
  design: { id: string };
  base_revision: { version: number; id?: string };
  latest_revision?: { version?: number; id?: string; actor?: string; created_at?: string };
  operations: DesignOperation[];
  operation_hash: string;
  recovery_created_at: string;
  patch_sha256: string;
}

export interface ConflictPatchArtifact {
  filename: string;
  mediaType: "application/vnd.formaspec.patch+json";
  json: string;
  sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`);
  return value;
}

function positiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer.`);
  return value as number;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_OPAQUE_ID_PATTERN.test(value)) throw new Error(`${label} is not a valid opaque identifier.`);
  return value;
}

function optionalOpaqueId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : opaqueId(value, label);
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function optionalActor(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SAFE_ACTOR_PATTERN.test(value)) throw new Error(`${label} is not valid.`);
  return value;
}

function optionalVersion(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveVersion(value, label);
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : isoTimestamp(value, label);
}

function designIdentity(value: unknown, label: string): { id: string } {
  const record = exactRecord(value, ["id"], label);
  return { id: String(DocumentIdSchema.parse(record.id)) };
}

function baseRevisionIdentity(value: unknown, label: string): ConflictRevisionIdentity {
  const record = exactRecord(value, ["version", "id"], label);
  return {
    version: positiveVersion(record.version, `${label}.version`),
    ...(record.id === undefined ? {} : { id: opaqueId(record.id, `${label}.id`) }),
  };
}

function latestRevisionIdentity(value: unknown, label: string): ConflictLatestRevision {
  const record = exactRecord(value, ["version", "id", "actor", "createdAt"], label);
  const revision: ConflictLatestRevision = {
    ...(record.version === undefined ? {} : { version: positiveVersion(record.version, `${label}.version`) }),
    ...(record.id === undefined ? {} : { id: opaqueId(record.id, `${label}.id`) }),
    ...(record.actor === undefined ? {} : { actor: optionalActor(record.actor, `${label}.actor`)! }),
    ...(record.createdAt === undefined ? {} : { createdAt: isoTimestamp(record.createdAt, `${label}.createdAt`) }),
  };
  if (Object.keys(revision).length === 0) throw new Error(`${label} must identify at least one supplied latest-revision field.`);
  return revision;
}

export function normalizeConflictRecoveryOperations(input: unknown): DesignOperation[] {
  const operations = DesignOperationListSchema.parse(structuredClone(input));
  const canonicalBytes = new TextEncoder().encode(canonicalJson(operations)).byteLength;
  if (operations.length > MAX_CONFLICT_RECOVERY_OPERATIONS
    || canonicalBytes > MAX_CONFLICT_RECOVERY_OPERATION_BYTES) {
    throw new Error("Conflict recovery accepts at most 500 operations or 1 MiB of canonical operation JSON.");
  }
  return operations;
}

function parseConflictRecoveryStructure(input: unknown): ConflictRecovery {
  const record = exactRecord(
    input,
    ["kind", "schemaVersion", "design", "baseRevision", "latestRevision", "operations", "operationHash", "createdAt"],
    "Conflict recovery",
  );
  if (record.kind !== CONFLICT_RECOVERY_KIND || record.schemaVersion !== 1) {
    throw new Error("Conflict recovery format is not supported.");
  }
  if (typeof record.operationHash !== "string" || !SHA256_PATTERN.test(record.operationHash)) {
    throw new Error("Conflict recovery operationHash must be a lowercase SHA-256 digest.");
  }
  const operations = normalizeConflictRecoveryOperations(record.operations);
  if (operations.length === 0) throw new Error("Conflict recovery must contain at least one operation.");
  return {
    kind: CONFLICT_RECOVERY_KIND,
    schemaVersion: 1,
    design: designIdentity(record.design, "Conflict recovery design"),
    baseRevision: baseRevisionIdentity(record.baseRevision, "Conflict recovery baseRevision"),
    ...(record.latestRevision === undefined
      ? {}
      : { latestRevision: latestRevisionIdentity(record.latestRevision, "Conflict recovery latestRevision") }),
    operations,
    operationHash: record.operationHash,
    createdAt: isoTimestamp(record.createdAt, "Conflict recovery createdAt"),
  };
}

/** JSON Canonicalization used for hashes and portable patch bytes. Object keys are sorted recursively. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error("Canonical JSON cannot contain undefined or non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot create a SHA-256 conflict-recovery patch.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function designOperationHash(operations: readonly DesignOperation[]): Promise<string> {
  const normalized = normalizeConflictRecoveryOperations(operations);
  return sha256Hex(canonicalJson(normalized));
}

export function latestRevisionFromConflictDetails(details: unknown): ConflictLatestRevision | undefined {
  if (!isRecord(details)) return undefined;
  const nested = isRecord(details.latestRevision)
    ? details.latestRevision
    : isRecord(details.currentRevision)
      ? details.currentRevision
      : {};
  const pick = (...keys: string[]): unknown => {
    for (const source of [nested, details]) {
      for (const key of keys) if (source[key] !== undefined) return source[key];
    }
    return undefined;
  };
  const candidate: ConflictLatestRevision = {};
  const version = optionalVersion(pick("version", "currentVersion", "latestVersion"), "Conflict latest revision version");
  const id = optionalOpaqueId(pick("id", "revisionId", "currentRevisionId", "latestRevisionId"), "Conflict latest revision id");
  const actor = optionalActor(pick("actor", "actorId", "currentActor", "currentActorId", "latestActor", "latestActorId"), "Conflict latest revision actor");
  const createdAt = optionalTimestamp(
    pick("createdAt", "timestamp", "currentCreatedAt", "currentRevisionCreatedAt", "currentTimestamp", "latestCreatedAt", "latestTimestamp"),
    "Conflict latest revision timestamp",
  );
  if (version !== undefined) candidate.version = version;
  if (id !== undefined) candidate.id = id;
  if (actor !== undefined) candidate.actor = actor;
  if (createdAt !== undefined) candidate.createdAt = createdAt;
  return Object.keys(candidate).length > 0 ? candidate : undefined;
}

export async function createConflictRecovery(input: {
  designId: string;
  baseVersion: number;
  baseRevisionId?: string;
  latestRevision?: ConflictLatestRevision;
  operations: readonly DesignOperation[];
  createdAt?: string;
}): Promise<ConflictRecovery> {
  const operations = normalizeConflictRecoveryOperations(input.operations);
  if (operations.length === 0) throw new Error("A conflict recovery requires at least one pending operation.");
  const recovery: ConflictRecovery = {
    kind: CONFLICT_RECOVERY_KIND,
    schemaVersion: 1,
    design: { id: String(DocumentIdSchema.parse(input.designId)) },
    baseRevision: {
      version: positiveVersion(input.baseVersion, "Conflict recovery base version"),
      ...(input.baseRevisionId === undefined ? {} : { id: opaqueId(input.baseRevisionId, "Conflict recovery base revision id") }),
    },
    ...(input.latestRevision === undefined
      ? {}
      : { latestRevision: latestRevisionIdentity(input.latestRevision, "Conflict recovery latest revision") }),
    operations,
    operationHash: await designOperationHash(operations),
    createdAt: isoTimestamp(input.createdAt ?? new Date().toISOString(), "Conflict recovery creation time"),
  };
  return recovery;
}

export async function parseConflictRecovery(input: unknown): Promise<ConflictRecovery> {
  const recovery = parseConflictRecoveryStructure(input);
  if (await designOperationHash(recovery.operations) !== recovery.operationHash) {
    throw new Error("Conflict recovery operation hash does not match its operations.");
  }
  return recovery;
}

function conflictRecoveryStorageKey(designId: string): string {
  return `formaspec.conflict-recovery.v1:${String(DocumentIdSchema.parse(designId))}`;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function persistConflictRecovery(recovery: ConflictRecovery): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(conflictRecoveryStorageKey(recovery.design.id), canonicalJson(recovery));
    return true;
  } catch {
    return false;
  }
}

export async function loadPersistedConflictRecovery(designId: string): Promise<ConflictRecovery | null> {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const stored = storage.getItem(conflictRecoveryStorageKey(designId));
    if (!stored) return null;
    const raw = JSON.parse(stored) as unknown;
    if (canonicalJson(raw) !== stored) throw new Error("Stored conflict recovery is not canonical JSON.");
    const recovery = await parseConflictRecovery(raw);
    if (recovery.design.id !== designId) throw new Error("Stored conflict recovery belongs to another design.");
    return recovery;
  } catch {
    return null;
  }
}

export function removePersistedConflictRecovery(designId: string): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.removeItem(conflictRecoveryStorageKey(designId));
    return true;
  } catch {
    return false;
  }
}

function unsignedPatch(recovery: ConflictRecovery): Omit<FormaSpecConflictPatchV1, "patch_sha256"> {
  return {
    format: CONFLICT_PATCH_FORMAT,
    schema_version: 1,
    design: { id: recovery.design.id },
    base_revision: {
      version: recovery.baseRevision.version,
      ...(recovery.baseRevision.id === undefined ? {} : { id: recovery.baseRevision.id }),
    },
    ...(recovery.latestRevision === undefined
      ? {}
      : {
          latest_revision: {
            ...(recovery.latestRevision.version === undefined ? {} : { version: recovery.latestRevision.version }),
            ...(recovery.latestRevision.id === undefined ? {} : { id: recovery.latestRevision.id }),
            ...(recovery.latestRevision.actor === undefined ? {} : { actor: recovery.latestRevision.actor }),
            ...(recovery.latestRevision.createdAt === undefined ? {} : { created_at: recovery.latestRevision.createdAt }),
          },
        }),
    operations: normalizeConflictRecoveryOperations(recovery.operations),
    operation_hash: recovery.operationHash,
    recovery_created_at: recovery.createdAt,
  };
}

function parsePatchStructure(input: unknown): FormaSpecConflictPatchV1 {
  const record = exactRecord(
    input,
    ["format", "schema_version", "design", "base_revision", "latest_revision", "operations", "operation_hash", "recovery_created_at", "patch_sha256"],
    "FormaSpec patch",
  );
  if (record.format !== CONFLICT_PATCH_FORMAT || record.schema_version !== 1) throw new Error("FormaSpec patch format is not supported.");
  if (typeof record.operation_hash !== "string" || !SHA256_PATTERN.test(record.operation_hash)) throw new Error("FormaSpec patch operation_hash is invalid.");
  if (typeof record.patch_sha256 !== "string" || !SHA256_PATTERN.test(record.patch_sha256)) throw new Error("FormaSpec patch patch_sha256 is invalid.");
  const baseRevision = baseRevisionIdentity(record.base_revision, "FormaSpec patch base_revision");
  let latestRevision: FormaSpecConflictPatchV1["latest_revision"];
  if (record.latest_revision !== undefined) {
    const latest = exactRecord(record.latest_revision, ["version", "id", "actor", "created_at"], "FormaSpec patch latest_revision");
    latestRevision = {
      ...(latest.version === undefined ? {} : { version: positiveVersion(latest.version, "FormaSpec patch latest_revision.version") }),
      ...(latest.id === undefined ? {} : { id: opaqueId(latest.id, "FormaSpec patch latest_revision.id") }),
      ...(latest.actor === undefined ? {} : { actor: optionalActor(latest.actor, "FormaSpec patch latest_revision.actor")! }),
      ...(latest.created_at === undefined ? {} : { created_at: isoTimestamp(latest.created_at, "FormaSpec patch latest_revision.created_at") }),
    };
    if (Object.keys(latestRevision).length === 0) throw new Error("FormaSpec patch latest_revision must not be empty.");
  }
  const operations = normalizeConflictRecoveryOperations(record.operations);
  if (operations.length === 0) throw new Error("FormaSpec patch must contain at least one operation.");
  return {
    format: CONFLICT_PATCH_FORMAT,
    schema_version: 1,
    design: designIdentity(record.design, "FormaSpec patch design"),
    base_revision: baseRevision,
    ...(latestRevision === undefined ? {} : { latest_revision: latestRevision }),
    operations,
    operation_hash: record.operation_hash,
    recovery_created_at: isoTimestamp(record.recovery_created_at, "FormaSpec patch recovery_created_at"),
    patch_sha256: record.patch_sha256,
  };
}

export async function parseConflictPatchJson(json: string): Promise<FormaSpecConflictPatchV1> {
  if (new TextEncoder().encode(json).byteLength > MAX_CONFLICT_PATCH_BYTES) {
    throw new Error("FormaSpec patch exceeds the 1 MiB operation limit plus its bounded envelope.");
  }
  const raw = JSON.parse(json) as unknown;
  if (`${canonicalJson(raw)}\n` !== json) throw new Error("FormaSpec patch must use canonical key ordering and one trailing newline.");
  const patch = parsePatchStructure(raw);
  if (await designOperationHash(patch.operations) !== patch.operation_hash) throw new Error("FormaSpec patch operation hash does not match its operations.");
  const { patch_sha256: _digest, ...unsigned } = patch;
  if (await sha256Hex(canonicalJson(unsigned)) !== patch.patch_sha256) throw new Error("FormaSpec patch SHA-256 does not match its canonical payload.");
  return patch;
}

export async function createConflictPatchArtifact(recoveryInput: ConflictRecovery): Promise<ConflictPatchArtifact> {
  const recovery = await parseConflictRecovery(recoveryInput);
  const unsigned = unsignedPatch(recovery);
  const sha256 = await sha256Hex(canonicalJson(unsigned));
  const patch: FormaSpecConflictPatchV1 = { ...unsigned, patch_sha256: sha256 };
  const json = `${canonicalJson(patch)}\n`;
  if (new TextEncoder().encode(json).byteLength > MAX_CONFLICT_PATCH_BYTES) {
    throw new Error("FormaSpec patch exceeds the 1 MiB operation limit plus its bounded envelope.");
  }
  const safeDesignId = recovery.design.id.replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    filename: `${safeDesignId}-base-v${recovery.baseRevision.version}-${recovery.operationHash.slice(0, 12)}.formaspec.patch.json`,
    mediaType: "application/vnd.formaspec.patch+json",
    json,
    sha256,
  };
}
