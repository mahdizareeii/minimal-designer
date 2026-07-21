import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RepositoryGrantStore } from "./grants.js";
import { scanRepository } from "./inventory.js";
import {
  assertInventoryMatchesPolicy,
  readBoundedResponseObject,
  readRepositoryScanPolicy,
  validateApiOrigin,
  validateMcpUrl,
  type RepositoryPolicyConnection,
} from "./policy.js";

const HANDOFF_ID = /^handoff_[a-f0-9]{32}$/;
const INVENTORY_ID = /^inventory_[a-f0-9]{32}$/;
const SHA_256 = /^[a-f0-9]{64}$/;
const AUTHORIZATION_PROBE_TIMEOUT_MS = 5_000;
const CENTRAL_READ_TIMEOUT_MS = 10_000;
const PROCESS_FORCE_KILL_MS = 2_000;

export interface CodexLaunchPlan {
  schemaVersion: 1;
  grantId: string;
  handoffId: string;
  handoffStatus: "implementing";
  handoffVersion: number;
  inventoryId: string;
  inventoryHash: string;
  repositoryFingerprint: string;
  repositoryRoot: string;
  executable: string;
  arguments: [string];
  taskReference: string;
}

export interface CodexProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  preSpawnAuthorizationProbe: () => Promise<void>;
  authorizationProbe: () => Promise<void>;
}

export type CodexProcessLauncher = (
  executable: string,
  arguments_: readonly string[],
  options: CodexProcessOptions,
) => Promise<number>;

export interface PrepareCodexLaunchOptions {
  grantStore: RepositoryGrantStore;
  grantId: string;
  handoffId: string;
  connection: RepositoryPolicyConnection;
  environment: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}

export interface ExecuteCodexLaunchOptions extends PrepareCodexLaunchOptions {
  processLauncher?: CodexProcessLauncher;
}

interface ImplementationHandoff {
  id: string;
  inventoryId: string;
  status: "implementing";
  currentVersion: number;
}

interface CentralRepositoryInventory {
  id: string;
  repositoryFingerprint: string;
  inventoryHash: string;
  status: "active" | "superseded" | "revoked";
}

const HANDOFF_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["in_review", "cancelled"],
  in_review: ["draft", "approved", "cancelled"],
  approved: ["implementing", "cancelled"],
  implementing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionNow(value: (() => Date) | undefined): Date {
  const now = value?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Codex launch clock returned an invalid time.");
  return now;
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out and authorization failed closed.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeLoopbackMcpUrl(value: string): URL {
  const url = validateMcpUrl(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost")) {
    throw new Error("Codex launch requires the credential-free loopback FormaSpec MCP bridge, or the explicit REST connection.");
  }
  return url;
}

function assertLaunchConnection(connection: RepositoryPolicyConnection): void {
  if ((connection.apiUrl === undefined) === (connection.mcpUrl === undefined)) {
    throw new Error("Codex launch requires exactly one authorized FormaSpec API or MCP connection.");
  }
  if (connection.mcpUrl !== undefined) {
    safeLoopbackMcpUrl(connection.mcpUrl);
    if (connection.bearerToken !== undefined) {
      throw new Error("The loopback FormaSpec MCP bridge must be credential-free to the Workspace Bridge client.");
    }
    return;
  }
  validateApiOrigin(connection.apiUrl as string);
  if (connection.bearerToken !== undefined
    && (connection.bearerToken.length === 0 || /[\r\n]/.test(connection.bearerToken))) {
    throw new Error("FormaSpec API bearer token is invalid.");
  }
}

async function callMcpTool(
  connection: RepositoryPolicyConnection,
  name: "handoff_read" | "repository_inventory_read",
  arguments_: Record<string, unknown>,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImplementation(safeLoopbackMcpUrl(connection.mcpUrl as string), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `formaspec-workspace-launch-${name}`,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(CENTRAL_READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`FormaSpec ${name} request failed with HTTP ${response.status}.`);
  const body = await readBoundedResponseObject(response, `FormaSpec ${name}`);
  const result = recordValue(body.result);
  const structured = recordValue(result?.structuredContent);
  if (structured?.ok !== true) throw new Error(`FormaSpec ${name} returned an authorization or domain error.`);
  return structured;
}

async function readApiRecord(
  connection: RepositoryPolicyConnection,
  pathname: string,
  label: string,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown>> {
  const headers = new Headers({ accept: "application/json" });
  if (connection.bearerToken !== undefined) headers.set("authorization", `Bearer ${connection.bearerToken}`);
  const response = await fetchImplementation(new URL(pathname, validateApiOrigin(connection.apiUrl as string)), {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(CENTRAL_READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}.`);
  return readBoundedResponseObject(response, label);
}

function parseImplementationHandoff(value: unknown, expectedId: string): ImplementationHandoff {
  const handoff = recordValue(value);
  if (handoff === null
    || handoff.id !== expectedId
    || typeof handoff.inventoryId !== "string" || !INVENTORY_ID.test(handoff.inventoryId)
    || handoff.status !== "implementing"
    || typeof handoff.currentVersion !== "number" || !Number.isSafeInteger(handoff.currentVersion) || handoff.currentVersion < 1
    || !Array.isArray(handoff.transitions)) {
    throw new Error("FormaSpec handoff is not explicitly authorized for implementation.");
  }
  const transitions = handoff.transitions.map(recordValue);
  if (transitions.some((transition) => transition === null)
    || transitions.length === 0
    || transitions[0]?.fromStatus !== null
    || transitions[0]?.toStatus !== "draft") {
    throw new Error("FormaSpec handoff transition history is incomplete or malformed.");
  }
  let transitionStatus = "draft";
  for (const transition of transitions.slice(1)) {
    if (transition?.fromStatus !== transitionStatus
      || typeof transition.toStatus !== "string"
      || !(HANDOFF_TRANSITIONS[transitionStatus] ?? []).includes(transition.toStatus)) {
      throw new Error("FormaSpec handoff transition history is incomplete or malformed.");
    }
    transitionStatus = transition.toStatus;
  }
  if (transitionStatus !== handoff.status) {
    throw new Error("FormaSpec handoff status does not match its immutable transition history.");
  }
  const approval = [...transitions].reverse().find((transition) => transition?.toStatus === "approved");
  const approvalDetails = recordValue(approval?.details);
  if (approval?.fromStatus !== "in_review"
    || approvalDetails?.decision !== "approved"
    || approvalDetails.approvedVersion !== handoff.currentVersion
    || approvalDetails.acceptanceCriteriaConfirmed !== true
    || approvalDetails.implementationPlanConfirmed !== true) {
    throw new Error("FormaSpec handoff approval metadata is incomplete or does not match its immutable version.");
  }
  const implementation = transitions.at(-1);
  const implementationDetails = recordValue(implementation?.details);
  if (implementation?.fromStatus !== "approved"
    || implementation?.toStatus !== "implementing"
    || implementationDetails?.decision !== "implementation_authorized"
    || implementationDetails.authorization !== "start_implementation"
    || implementationDetails.approvedVersion !== handoff.currentVersion) {
    throw new Error("FormaSpec handoff implementation authorization is incomplete or stale.");
  }
  const specification = recordValue(handoff.specification);
  const implementationPolicy = recordValue(specification?.implementationPolicy);
  if ((implementationPolicy?.preferredIsolation !== "worktree" && implementationPolicy?.preferredIsolation !== "branch")
    || implementationPolicy.commitRequiresExplicitApproval !== true
    || implementationPolicy.pullRequestRequiresExplicitRequest !== true) {
    throw new Error("FormaSpec handoff does not contain the required explicit implementation safeguards.");
  }
  return {
    id: expectedId,
    inventoryId: handoff.inventoryId,
    status: handoff.status,
    currentVersion: handoff.currentVersion,
  };
}

function parseCentralInventory(value: unknown, expectedId: string): CentralRepositoryInventory {
  const inventory = recordValue(value);
  const content = recordValue(inventory?.inventory);
  if (inventory === null
    || inventory.id !== expectedId
    || typeof inventory.repositoryFingerprint !== "string" || !SHA_256.test(inventory.repositoryFingerprint)
    || typeof inventory.inventoryHash !== "string" || !SHA_256.test(inventory.inventoryHash)
    || (inventory.status !== "active" && inventory.status !== "superseded" && inventory.status !== "revoked")
    || content?.repositoryFingerprint !== inventory.repositoryFingerprint) {
    throw new Error("FormaSpec returned invalid persisted repository inventory metadata.");
  }
  return {
    id: expectedId,
    repositoryFingerprint: inventory.repositoryFingerprint,
    inventoryHash: inventory.inventoryHash,
    status: inventory.status,
  };
}

async function readCentralLaunchContext(
  connection: RepositoryPolicyConnection,
  handoffId: string,
  fetchImplementation: typeof fetch,
): Promise<{ handoff: ImplementationHandoff; inventory: CentralRepositoryInventory }> {
  let handoffBody: Record<string, unknown>;
  if (connection.mcpUrl !== undefined) {
    handoffBody = await callMcpTool(connection, "handoff_read", { handoff_id: handoffId }, fetchImplementation);
  } else {
    handoffBody = await readApiRecord(
      connection,
      `/api/handoffs/${encodeURIComponent(handoffId)}`,
      "FormaSpec handoff",
      fetchImplementation,
    );
  }
  const handoff = parseImplementationHandoff(handoffBody.handoff, handoffId);
  let inventoryBody: Record<string, unknown>;
  if (connection.mcpUrl !== undefined) {
    inventoryBody = await callMcpTool(
      connection,
      "repository_inventory_read",
      { inventory_id: handoff.inventoryId },
      fetchImplementation,
    );
  } else {
    inventoryBody = await readApiRecord(
      connection,
      `/api/repository-inventories/${encodeURIComponent(handoff.inventoryId)}`,
      "FormaSpec repository inventory",
      fetchImplementation,
    );
  }
  return { handoff, inventory: parseCentralInventory(inventoryBody.inventory, handoff.inventoryId) };
}

function executableCandidates(name: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`, `${name}.com`] : [name];
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return environment[name];
  const match = Object.entries(environment).find(([candidate]) => candidate.toUpperCase() === name.toUpperCase());
  return match?.[1];
}

export function findCodexExecutable(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const directory of (environmentValue(environment, "PATH", platform) ?? "").split(delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const candidateName of executableCandidates("codex", platform)) {
      const candidate = path.join(directory, candidateName);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)) return candidate;
      } catch {
        // Ignore missing and unreadable PATH entries.
      }
    }
  }
  return null;
}

export function sanitizedCodexEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "APPDATA", "CODEX_HOME", "COLORTERM", "COMSPEC", "FORCE_COLOR", "HOME", "LANG", "LOCALAPPDATA",
    "LC_ADDRESS", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_MESSAGES",
    "LC_MONETARY", "LC_NAME", "LC_NUMERIC", "LC_PAPER", "LC_TELEPHONE", "LC_TIME", "LOGNAME", "NO_COLOR",
    "PATH", "PATHEXT", "SHELL", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TERM",
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TMP", "TMPDIR", "TZ", "USER", "USERPROFILE", "WINDIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  ]);
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    const canonicalName = platform === "win32" ? name.toUpperCase() : name;
    if (!allowed.has(canonicalName)) continue;
    if (sanitized[canonicalName] !== undefined && sanitized[canonicalName] !== value) {
      throw new Error(`Conflicting ${canonicalName} environment values are unsafe.`);
    }
    sanitized[canonicalName] = value;
  }
  return sanitized;
}

function signalCodexProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function codexProcessTreeExists(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const spawnCodexProcess: CodexProcessLauncher = async (executable, arguments_, options) => {
  await options.preSpawnAuthorizationProbe();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: sanitizedCodexEnvironment(options.env),
      detached: process.platform !== "win32",
      shell: false,
      stdio: "inherit",
    });
    let probing = false;
    let authorizationRevoked = false;
    let exited = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const authorizationMonitor = setInterval(() => {
      if (probing || authorizationRevoked) return;
      probing = true;
      void options.authorizationProbe().catch(() => {
        if (exited) return;
        authorizationRevoked = true;
        clearInterval(authorizationMonitor);
        signalCodexProcessTree(child, "SIGTERM");
        forceKill = setTimeout(() => {
          signalCodexProcessTree(child, "SIGKILL");
          forceKill = undefined;
        }, PROCESS_FORCE_KILL_MS);
      }).finally(() => {
        probing = false;
      });
    }, 500);
    authorizationMonitor.unref();
    child.once("error", (error) => {
      exited = true;
      clearInterval(authorizationMonitor);
      if (forceKill !== undefined && !codexProcessTreeExists(child)) clearTimeout(forceKill);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      clearInterval(authorizationMonitor);
      if (forceKill !== undefined && !codexProcessTreeExists(child)) clearTimeout(forceKill);
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
};

export async function prepareCodexLaunch(options: PrepareCodexLaunchOptions): Promise<CodexLaunchPlan> {
  if (!HANDOFF_ID.test(options.handoffId)) throw new Error("FormaSpec handoff ID is invalid.");
  assertLaunchConnection(options.connection);
  const grant = await options.grantStore.requireActive(options.grantId, optionNow(options.now));
  if (grant.persistedInventory === null) {
    throw new Error("Repository grant is not bound to a persisted FormaSpec inventory; create a new connected grant.");
  }
  const policy = await withDeadline(
    () => readRepositoryScanPolicy(options.connection, options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    CENTRAL_READ_TIMEOUT_MS,
    "FormaSpec organization-policy read",
  );
  if (grant.excludedPatterns.length !== policy.excludedPatterns.length
    || grant.excludedPatterns.some((pattern, index) => pattern !== policy.excludedPatterns[index])) {
    throw new Error("Organization repository exclusions changed after authorization; create a new explicit grant.");
  }
  const localInventory = await scanRepository(grant.repositoryRoot, {
    excludedPatterns: grant.excludedPatterns,
    limits: { maximumEntities: policy.maximumInventoryEntities },
  });
  if (localInventory.repositoryFingerprint !== grant.repositoryFingerprint) {
    throw new Error("Repository contents changed after authorization; create a new explicit grant.");
  }
  if (localInventory.truncated) {
    throw new Error("Repository fingerprint or inventory limits were reached; launch requires a complete new grant.");
  }
  assertInventoryMatchesPolicy(localInventory, policy);
  const central = await withDeadline(
    () => readCentralLaunchContext(
      options.connection,
      options.handoffId,
      options.fetchImplementation ?? fetch,
    ),
    CENTRAL_READ_TIMEOUT_MS,
    "FormaSpec approved-handoff read",
  );
  if (central.handoff.inventoryId !== grant.persistedInventory.id) {
    throw new Error("Approved handoff is pinned to a different repository inventory than the selected local grant.");
  }
  if (central.inventory.status !== "active") {
    throw new Error(`Persisted repository inventory is ${central.inventory.status}; launch is revoked.`);
  }
  if (central.inventory.id !== grant.persistedInventory.id
    || central.inventory.inventoryHash !== grant.persistedInventory.inventoryHash
    || central.inventory.repositoryFingerprint !== grant.repositoryFingerprint) {
    throw new Error("Central repository inventory does not match the selected local grant binding.");
  }
  const executable = findCodexExecutable(options.environment);
  if (executable === null) throw new Error("Codex CLI was not found in a trusted absolute PATH entry.");
  const taskReference = `formaspec://handoffs/${options.handoffId}`;
  const prompt = `[@Minimal UI](plugin://minimal-ui@formaspec) Use Minimal UI. Implement the approved FormaSpec engineering handoff ${taskReference} at immutable version ${central.handoff.currentVersion}, pinned to repository inventory ${central.inventory.id} with SHA-256 ${central.inventory.inventoryHash}. Read and verify those exact values through the configured formaspec MCP server before changing files; abort if they differ. Work only in the current selected repository. Follow the handoff isolation and validation plan. Do not commit without explicit approval and do not create a pull request unless explicitly requested.`;
  return {
    schemaVersion: 1,
    grantId: grant.id,
    handoffId: central.handoff.id,
    handoffStatus: central.handoff.status,
    handoffVersion: central.handoff.currentVersion,
    inventoryId: central.inventory.id,
    inventoryHash: central.inventory.inventoryHash,
    repositoryFingerprint: grant.repositoryFingerprint,
    repositoryRoot: grant.repositoryRoot,
    executable,
    arguments: [prompt],
    taskReference,
  };
}

async function assertLaunchAuthorizationStillActive(
  plan: CodexLaunchPlan,
  options: ExecuteCodexLaunchOptions,
  verifyRepositoryFingerprint: boolean,
): Promise<void> {
  const grant = await options.grantStore.requireActive(options.grantId, optionNow(options.now));
  if (grant.id !== plan.grantId
    || grant.repositoryRoot !== plan.repositoryRoot
    || grant.repositoryFingerprint !== plan.repositoryFingerprint
    || grant.persistedInventory?.id !== plan.inventoryId
    || grant.persistedInventory.inventoryHash !== plan.inventoryHash) {
    throw new Error("Repository grant changed or was revoked after launch approval.");
  }
  const policy = await readRepositoryScanPolicy(options.connection, options.fetchImplementation === undefined
    ? {}
    : { fetchImplementation: options.fetchImplementation });
  if (grant.excludedPatterns.length !== policy.excludedPatterns.length
    || grant.excludedPatterns.some((pattern, index) => pattern !== policy.excludedPatterns[index])) {
    throw new Error("Organization repository exclusions changed after launch review.");
  }
  if (verifyRepositoryFingerprint) {
    const localInventory = await scanRepository(grant.repositoryRoot, {
      excludedPatterns: grant.excludedPatterns,
      limits: { maximumEntities: policy.maximumInventoryEntities },
    });
    if (localInventory.truncated || localInventory.repositoryFingerprint !== plan.repositoryFingerprint) {
      throw new Error("Repository contents changed after launch review.");
    }
    assertInventoryMatchesPolicy(localInventory, policy);
  }
  const central = await readCentralLaunchContext(
    options.connection,
    plan.handoffId,
    options.fetchImplementation ?? fetch,
  );
  if (central.handoff.currentVersion !== plan.handoffVersion
    || central.handoff.inventoryId !== plan.inventoryId
    || central.inventory.id !== plan.inventoryId
    || central.inventory.inventoryHash !== plan.inventoryHash
    || central.inventory.repositoryFingerprint !== plan.repositoryFingerprint
    || central.inventory.status !== "active") {
    throw new Error("FormaSpec revoked or changed the approved launch context.");
  }
}

export async function executeCodexLaunch(
  preparedPlan: CodexLaunchPlan,
  options: ExecuteCodexLaunchOptions,
): Promise<{ plan: CodexLaunchPlan; exitCode: number }> {
  const plan = await prepareCodexLaunch(options);
  if (plan.schemaVersion !== preparedPlan.schemaVersion
    || plan.grantId !== preparedPlan.grantId
    || plan.handoffId !== preparedPlan.handoffId
    || plan.handoffStatus !== preparedPlan.handoffStatus
    || plan.handoffVersion !== preparedPlan.handoffVersion
    || plan.inventoryId !== preparedPlan.inventoryId
    || plan.inventoryHash !== preparedPlan.inventoryHash
    || plan.repositoryFingerprint !== preparedPlan.repositoryFingerprint
    || plan.repositoryRoot !== preparedPlan.repositoryRoot
    || plan.executable !== preparedPlan.executable
    || plan.arguments.length !== preparedPlan.arguments.length
    || plan.arguments[0] !== preparedPlan.arguments[0]
    || plan.taskReference !== preparedPlan.taskReference) {
    throw new Error("Codex launch context changed after review; print and review a new launch plan.");
  }
  const preSpawnAuthorizationProbe = () => withDeadline(
    () => assertLaunchAuthorizationStillActive(plan, options, true),
    CENTRAL_READ_TIMEOUT_MS,
    "Codex pre-spawn authorization probe",
  );
  const authorizationProbe = () => withDeadline(
    () => assertLaunchAuthorizationStillActive(plan, options, false),
    AUTHORIZATION_PROBE_TIMEOUT_MS,
    "Codex ongoing authorization probe",
  );
  await preSpawnAuthorizationProbe();
  const exitCode = await (options.processLauncher ?? spawnCodexProcess)(
    plan.executable,
    plan.arguments,
    {
      cwd: plan.repositoryRoot,
      env: sanitizedCodexEnvironment(options.environment),
      preSpawnAuthorizationProbe,
      authorizationProbe,
    },
  );
  return { plan, exitCode };
}
