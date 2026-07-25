import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Copy,
  DatabaseBackup,
  Download,
  ExternalLink,
  FileArchive,
  KeyRound,
  LoaderCircle,
  Palette,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { navigate, type AdministrationSection } from "../App";
import { DesignSystemComponentAuthoring } from "./DesignSystemComponentAuthoring";
import { DesignSystemProjectPins } from "./DesignSystemProjectPins";
import { OrganizationPolicyEditor } from "./OrganizationPolicyEditor";
import {
  backupDownloadUrl,
  createBackup,
  createCodexConnection,
  createOrganizationDesignSystem,
  importPortableProject,
  listAgentConnections,
  listBackups,
  listDesignSystems,
  readOrganizationPolicy,
  registerBackupImport,
  reconnectAgentConnection,
  revokeAgentConnection,
  validatePortableImport,
  validateBackupImport,
  verifyBackup,
  updateOrganizationPolicy,
  ApiError,
  type AgentConnectionRecord,
  type AgentPairingChallenge,
  type BackupRecord,
  type BackupImportValidation,
  type DesignSystemRecord,
  type OrganizationPolicyRecord,
  type PortableImportMode,
  type PortableImportValidation,
} from "../lib/api";

function dateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : value;
}

function fileSize(value: number | null): string {
  if (value === null) return "Size unavailable";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function managedBackupRestoreCommand(backupId: string): string {
  if (!/^backup_[a-f0-9]{40}$/.test(backupId)) {
    throw new Error("The managed backup ID is not safe to use in a restore command.");
  }
  return `formaspecctl backup restore --backup-id ${backupId} --yes`;
}

function assertSafePairingChallenge(challenge: AgentPairingChallenge): void {
  if (!/^fspair_[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
    || !/^connection_[a-f0-9]{32}$/.test(challenge.connection.id)) {
    throw new Error("The Codex pairing challenge is not safe to place in a command.");
  }
}

interface AdministrationRuntimeHealth {
  ok: boolean;
  status: "ready" | "maintenance" | "unavailable";
  dataStoreId: string;
  migrationVersion: number;
}

const ADMINISTRATION_NAVIGATION: ReadonlyArray<{
  section: AdministrationSection;
  href: string;
  label: string;
  description: string;
}> = [
  { section: "overview", href: "/administration", label: "Overview", description: "Health and next action" },
  { section: "agents", href: "/administration/agents", label: "Connections", description: "Codex and agent access" },
  { section: "design-system", href: "/administration/design-system", label: "Design system", description: "Libraries and project pins" },
  { section: "policy", href: "/administration/policy", label: "Policy", description: "Organization boundaries" },
  { section: "backups", href: "/administration/backups", label: "Backups", description: "Verified recovery points" },
  { section: "imports", href: "/administration/imports", label: "Import", description: "Portable projects" },
];

const ADMINISTRATION_SECTION_COPY: Record<AdministrationSection, { title: string; description: string }> = {
  overview: { title: "Workspace overview", description: "Live runtime identity, recovery readiness, and the next safe action." },
  agents: { title: "FormaSpec MCP connection", description: "Install or reconnect the managed Codex MCP in one click, then run tasks only from Codex or the CLI." },
  "design-system": { title: "Design system", description: "Manage organization libraries, reusable components, and project release pins." },
  policy: { title: "Organization policy", description: "Edit one focused policy category at a time with optimistic-lock protection." },
  backups: { title: "Backups and recovery", description: "Create, verify, download, and register managed recovery points." },
  imports: { title: "Project import", description: "Validate a portable project before making a bounded, non-destructive import." },
};

async function readAdministrationRuntimeHealth(): Promise<AdministrationRuntimeHealth> {
  const response = await fetch("/health/ready", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json() as {
    ok?: unknown;
    status?: unknown;
    dataStoreId?: unknown;
    migrations?: unknown;
  };
  if (typeof body.dataStoreId !== "string" || !/^store_[a-f0-9]{32}$/.test(body.dataStoreId)
    || !Number.isSafeInteger(body.migrations) || Number(body.migrations) < 1) {
    throw new Error("The live runtime returned incomplete identity or migration information.");
  }
  return {
    ok: response.ok && body.ok === true,
    status: response.ok && body.ok === true ? "ready" : body.status === "maintenance" ? "maintenance" : "unavailable",
    dataStoreId: body.dataStoreId,
    migrationVersion: Number(body.migrations),
  };
}

export function codexPairingCommand(challenge: AgentPairingChallenge): string {
  assertSafePairingChallenge(challenge);
  return `formaspecctl --yes agent connect codex --pairing-nonce ${challenge.nonce} --connection-id ${challenge.connection.id}`;
}

export function codexPairingLink(challenge: AgentPairingChallenge): string {
  assertSafePairingChallenge(challenge);
  const url = new URL("formaspec://connect-agent");
  url.searchParams.set("connection", challenge.connection.id);
  url.searchParams.set("nonce", challenge.nonce);
  return url.toString();
}

export function openCodexPairingLink(link: string): void {
  const url = new URL(link);
  const connectionId = url.searchParams.get("connection") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (url.protocol !== "formaspec:" || url.hostname !== "connect-agent" || url.pathname || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "connection" && key !== "nonce")
    || url.searchParams.getAll("connection").length !== 1
    || url.searchParams.getAll("nonce").length !== 1
    || !/^connection_[a-f0-9]{32}$/.test(connectionId)
    || !/^fspair_[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error("The FormaSpec MCP connection link is invalid.");
  }
  const anchor = document.createElement("a");
  anchor.href = url.toString();
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function agentConnectionDisplayName(connection: Pick<AgentConnectionRecord, "adapter" | "displayName">): string {
  return connection.adapter === "codex" ? "Codex — FormaSpec" : connection.displayName;
}

export function agentConnectionCanReconnect(connection: Pick<AgentConnectionRecord, "status">): boolean {
  return connection.status === "active" || connection.status === "pending";
}

export function groupAgentConnections(connections: readonly AgentConnectionRecord[]): {
  current: AgentConnectionRecord[];
  history: AgentConnectionRecord[];
} {
  const statusRank: Record<AgentConnectionRecord["status"], number> = {
    active: 0,
    pending: 1,
    error: 2,
    expired: 3,
    revoked: 4,
  };
  const ordered = [...connections].sort((left, right) => {
    const statusDifference = statusRank[left.status] - statusRank[right.status];
    if (statusDifference !== 0) return statusDifference;
    const timeDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return Number.isFinite(timeDifference) && timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
  });
  return {
    current: ordered.filter((connection) => connection.status !== "expired" && connection.status !== "revoked"),
    history: ordered.filter((connection) => connection.status === "expired" || connection.status === "revoked"),
  };
}

export function Administration({ section = "overview" }: { section?: AdministrationSection }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [connections, setConnections] = useState<AgentConnectionRecord[]>([]);
  const [designSystems, setDesignSystems] = useState<DesignSystemRecord[]>([]);
  const [designSystemName, setDesignSystemName] = useState("Company Design System");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<PortableImportValidation | null>(null);
  const [portableFile, setPortableFile] = useState<File | null>(null);
  const [portableImportMode, setPortableImportMode] = useState<PortableImportMode>("conflict_fail");
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupImportValidation, setBackupImportValidation] = useState<BackupImportValidation | null>(null);
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [pairingCommand, setPairingCommand] = useState<string | null>(null);
  const [organizationPolicy, setOrganizationPolicy] = useState<OrganizationPolicyRecord | null>(null);
  const [canAdministerOrganization, setCanAdministerOrganization] = useState<boolean | null>(null);
  const [runtimeHealth, setRuntimeHealth] = useState<AdministrationRuntimeHealth | null>(null);
  const [runtimeHealthError, setRuntimeHealthError] = useState<string | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
  const connectionGroups = useMemo(() => groupAgentConnections(connections), [connections]);
  const activeConnection = useMemo(() => connectionGroups.current.find((connection) => connection.status === "active") ?? null, [connectionGroups]);
  const latestVerifiedBackup = useMemo(() => backups.find((backup) => backup.status === "valid") ?? null, [backups]);
  const sectionCopy = ADMINISTRATION_SECTION_COPY[section];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRuntimeHealthError(null);
    try {
      if (section === "overview") {
        const [backupsResult, connectionsResult, systemsResult, policyResult, healthResult] = await Promise.allSettled([
          listBackups(),
          listAgentConnections(),
          listDesignSystems(),
          readOrganizationPolicy(),
          readAdministrationRuntimeHealth(),
        ]);
        if (systemsResult.status === "rejected") throw systemsResult.reason;
        setDesignSystems(systemsResult.value);
        if (healthResult.status === "fulfilled") setRuntimeHealth(healthResult.value);
        else {
          setRuntimeHealth(null);
          setRuntimeHealthError(healthResult.reason instanceof Error ? healthResult.reason.message : "Runtime health is unavailable.");
        }
        const administrativeResults = [backupsResult, connectionsResult, policyResult];
        const restricted = administrativeResults.some((result) => result.status === "rejected"
          && result.reason instanceof ApiError
          && result.reason.status === 403);
        setCanAdministerOrganization(!restricted);
        if (restricted) {
          setBackups([]);
          setConnections([]);
          setOrganizationPolicy(null);
        } else {
          if (backupsResult.status === "rejected") throw backupsResult.reason;
          if (connectionsResult.status === "rejected") throw connectionsResult.reason;
          if (policyResult.status === "rejected") throw policyResult.reason;
          setBackups(backupsResult.value);
          setConnections(connectionsResult.value);
          setOrganizationPolicy(policyResult.value);
        }
      } else if (section === "design-system") {
        const [systemsResult, policyResult] = await Promise.allSettled([listDesignSystems(), readOrganizationPolicy()]);
        if (systemsResult.status === "rejected") throw systemsResult.reason;
        setDesignSystems(systemsResult.value);
        if (policyResult.status === "rejected") {
          if (policyResult.reason instanceof ApiError && policyResult.reason.status === 403) {
            setCanAdministerOrganization(false);
            setOrganizationPolicy(null);
          } else throw policyResult.reason;
        } else {
          setCanAdministerOrganization(true);
          setOrganizationPolicy(policyResult.value);
        }
      } else if (section === "backups") {
        setBackups(await listBackups());
        setCanAdministerOrganization(true);
      } else if (section === "agents") {
        setConnections(await listAgentConnections());
        setCanAdministerOrganization(true);
      } else if (section === "policy" || section === "imports") {
        setOrganizationPolicy(await readOrganizationPolicy());
        setCanAdministerOrganization(true);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) {
        setCanAdministerOrganization(false);
        setBackups([]);
        setConnections([]);
        setOrganizationPolicy(null);
      } else {
        setError(cause instanceof Error ? cause.message : "Administration data could not be loaded.");
      }
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!policyDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardHistoryNavigation = (event: PopStateEvent) => {
      if (window.location.pathname === "/administration/policy") return;
      if (window.confirm("Leave Organization policy and discard its unsaved changes?")) {
        setPolicyDirty(false);
        return;
      }
      event.stopImmediatePropagation();
      window.history.pushState({}, "", "/administration/policy");
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("popstate", guardHistoryNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("popstate", guardHistoryNavigation, true);
    };
  }, [policyDirty]);

  const navigateFromAdministration = (event: ReactMouseEvent<HTMLAnchorElement>, destination: string) => {
    event.preventDefault();
    if (policyDirty && !window.confirm("Leave Organization policy and discard its unsaved changes?")) return;
    setPolicyDirty(false);
    navigate(destination);
  };

  const refreshAdministration = () => {
    if (policyDirty && !window.confirm("Reload Organization policy and discard its unsaved changes?")) return;
    setPolicyDirty(false);
    void refresh();
  };

  const reportNotice = useCallback((message: string) => {
    setError(null);
    setNotice(message);
  }, []);
  const reportError = useCallback((message: string) => {
    setNotice(null);
    setError(message);
  }, []);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The operation failed."); }
    finally { setBusy(null); }
  };

  const connectCodex = async () => {
    await run("connect-codex", async () => {
      const challenge = await createCodexConnection();
      const link = codexPairingLink(challenge);
      setPairingCommand(codexPairingCommand(challenge));
      setPairingLink(link);
      openCodexPairingLink(link);
      setNotice("FormaSpec opened the installed connection handler. Codex will keep this MCP approval so tasks can start from Codex or the CLI; no website submission is required.");
      await refresh();
    });
  };

  const renderAgentConnection = (connection: AgentConnectionRecord) => {
    const displayName = agentConnectionDisplayName(connection);
    return (
      <article className="administration-row" key={connection.id}>
        <div className={`status-icon is-${connection.status}`}>{connection.status === "active" ? <CheckCircle2 size={16} /> : <Bot size={16} />}</div>
        <div className="administration-row-main">
          <strong>{displayName}</strong>
          <span>{connection.status} · Expires {dateTime(connection.expiresAt)} · Last used {dateTime(connection.lastUsedAt)}</span>
          <small>{connection.scopes.join(" · ")}</small>
          <small>{connection.projectIds.length > 0 ? `${connection.projectIds.length} restricted projects` : "All projects in this organization"}</small>
        </div>
        <div className="administration-row-actions">
          {agentConnectionCanReconnect(connection) && <button className="icon-button" title="Reconnect" disabled={busy !== null} onClick={() => void run(`reconnect-${connection.id}`, async () => {
            const challenge = await reconnectAgentConnection(connection.id);
            const link = codexPairingLink(challenge);
            setPairingCommand(codexPairingCommand(challenge));
            setPairingLink(link);
            openCodexPairingLink(link);
            setNotice("FormaSpec opened the installed connection handler with a renewed one-time pairing request.");
            await refresh();
          })}><RefreshCcw size={14} /></button>}
          {connection.status !== "revoked" && <button className="icon-button is-danger" title="Revoke immediately" disabled={busy !== null} onClick={() => {
            if (!window.confirm(`Revoke ${displayName} and all of its active grants immediately?`)) return;
            void run(`revoke-${connection.id}`, async () => {
              const revoked = await revokeAgentConnection(connection.id);
              setConnections((current) => current.map((item) => item.id === revoked.id ? revoked : item));
              setNotice(`${displayName} was revoked.`);
            });
          }}><Trash2 size={14} /></button>}
        </div>
      </article>
    );
  };

  return (
    <main className="administration-shell">
      <header className="administration-header">
        <a className="button button-secondary" href="/" onClick={(event) => navigateFromAdministration(event, "/")}><ArrowLeft size={14} /> Projects</a>
        <div className="administration-brand"><span><Sparkles size={16} /></span><div><strong>FormaSpec Administration</strong><small>{sectionCopy.title}</small></div></div>
        <button className="icon-button" onClick={refreshAdministration} aria-label="Refresh administration" disabled={loading}><RefreshCcw size={16} className={loading ? "spin" : ""} /></button>
      </header>

      <div className="administration-layout">
        <aside className="administration-sidebar">
          <nav aria-label="Administration sections">
            {ADMINISTRATION_NAVIGATION.map((item) => <a
              href={item.href}
              key={item.section}
              className={section === item.section ? "is-active" : ""}
              aria-current={section === item.section ? "page" : undefined}
              onClick={(event) => {
                if (section === item.section) {
                  event.preventDefault();
                  return;
                }
                navigateFromAdministration(event, item.href);
              }}
            >
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </a>)}
          </nav>
        </aside>

        <section className="administration-content">
        <header className="administration-route-heading">
          <div><span>{ADMINISTRATION_NAVIGATION.find((item) => item.section === section)?.label}</span><h1>{sectionCopy.title}</h1></div>
          <p>{sectionCopy.description}</p>
        </header>
        {error && <div className="administration-alert is-error"><XCircle size={16} /><span>{error}</span></div>}
        {notice && <div className="administration-alert"><CheckCircle2 size={16} /><span>{notice}</span></div>}
        {canAdministerOrganization === false && <div className="administration-alert"><ShieldCheck size={16} /><span>Limited organization access: Administrator-only policy, backup, agent, import, and system-creation controls are hidden. The server reports your available component-catalog actions below.</span></div>}

        {section === "overview" && <section className="administration-overview" aria-label="Workspace health overview">
          <div className="administration-overview-grid">
            <article>
              <span><Sparkles size={17} /></span>
              <div><small>Runtime</small><strong>{runtimeHealth?.ok ? "Ready" : loading ? "Checking…" : "Needs attention"}</strong><code>{typeof window === "undefined" ? "Current FormaSpec origin" : window.location.origin}</code></div>
            </article>
            <article>
              <span><ShieldCheck size={17} /></span>
              <div><small>Data store</small><strong>{runtimeHealth ? "Identity verified" : "Identity unavailable"}</strong><code>{runtimeHealth?.dataStoreId ?? runtimeHealthError ?? "Waiting for live runtime"}</code></div>
            </article>
            <article>
              <span><DatabaseBackup size={17} /></span>
              <div><small>Database migration</small><strong>{runtimeHealth ? `Schema ${runtimeHealth.migrationVersion}` : "Not reported"}</strong><span>{runtimeHealth?.status === "maintenance" ? "Runtime is in maintenance" : runtimeHealth?.ok ? "Reported by the live runtime" : "Run CLI diagnostics before migration"}</span></div>
            </article>
            <article>
              <span><Bot size={17} /></span>
              <div><small>FormaSpec MCP</small><strong>{activeConnection ? "Connected" : "Not connected"}</strong><span>{activeConnection ? `Expires ${dateTime(activeConnection.expiresAt)}` : "Connect once, then start tasks from Codex or the CLI"}</span></div>
            </article>
            <article>
              <span><FileArchive size={17} /></span>
              <div><small>Latest verified backup</small><strong>{latestVerifiedBackup?.filename ?? "No verified backup"}</strong><span>{latestVerifiedBackup ? `Verified ${dateTime(latestVerifiedBackup.verifiedAt)}` : "Create one before migrations or important changes"}</span></div>
            </article>
          </div>
          <div className="administration-next-action">
            <div><strong>Recommended next action</strong><span>{!runtimeHealth?.ok
              ? "Recover or inspect the recorded runtime before changing organization data."
              : !activeConnection
                ? "Install or connect FormaSpec MCP once. After that, create tasks only from Codex or the CLI."
                : !latestVerifiedBackup
                  ? "Create and download a verified recovery point before deployment."
                  : "Administration is healthy. Continue to your Products and Designs."}</span></div>
            <a className="button button-primary" href={!runtimeHealth?.ok
              ? "/administration/agents"
              : !activeConnection
                ? "/administration/agents"
                : !latestVerifiedBackup ? "/administration/backups" : "/"}
              onClick={(event) => navigateFromAdministration(event, !runtimeHealth?.ok
                ? "/administration/agents"
                : !activeConnection
                  ? "/administration/agents"
                  : !latestVerifiedBackup ? "/administration/backups" : "/")}
            >{!runtimeHealth?.ok ? "Check connections" : !activeConnection ? "Connect / install MCP" : !latestVerifiedBackup ? "Create backup" : "Open projects"}</a>
          </div>
        </section>}

        {section !== "overview" && <div className="administration-grid">
          {section === "backups" && canAdministerOrganization !== false && <section className="administration-card">
            <div className="administration-card-heading">
              <div><span><DatabaseBackup size={18} /></span><div><h2>Managed backups &amp; recovery</h2><p>Verified SQLite snapshots, assets, manifests, and checksums. Restore uses an opaque backup ID, never a server path.</p></div></div>
              <button className="button button-primary" disabled={busy !== null} onClick={() => void run("create-backup", async () => {
                const backup = await createBackup();
                setBackups((current) => [backup, ...current.filter((item) => item.id !== backup.id)]);
                setNotice(`Backup ${backup.filename} was created and verified.`);
              })}>{busy === "create-backup" ? <LoaderCircle size={14} className="spin" /> : <DatabaseBackup size={14} />} Create backup</button>
            </div>
            <div className="backup-recovery-note">
              <ShieldCheck size={16} />
              <div><strong>Safe restore workflow</strong><span>Verify the managed record, download an off-host copy if needed, then copy the restore command. FormaSpec performs maintenance mode, pre-restore backup, integrity checks, and rollback through <code>formaspecctl</code>.</span></div>
            </div>
            <div className="backup-import-panel" id="full-backup-import">
              <div className="backup-import-heading">
                <div><FileArchive size={16} /><span><strong>Load a full server backup</strong><small>Use a verified FormaSpec <code>.tar</code> backup from another installation.</small></span></div>
                <label className={`button button-secondary ${busy ? "is-disabled" : ""}`}><Upload size={14} /> Select backup<input type="file" accept=".tar,application/x-tar,application/octet-stream" hidden disabled={busy !== null} onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  setBackupFile(file);
                  setBackupImportValidation(null);
                  void run("validate-backup-import", async () => {
                    const result = await validateBackupImport(file);
                    setBackupImportValidation(result);
                    setNotice(`${file.name} passed checksum, SQLite, foreign-key, asset, and render verification. Current data has not changed.`);
                  });
                }} /></label>
              </div>
              <div className="full-restore-warning"><ShieldCheck size={16} /><div><strong>Registration is safe; full restore is destructive</strong><span>This upload only adds a verified, content-addressed managed backup. It does not replace the running workspace. Restoring it later requires downtime, a pre-restore safety backup, integrity checks, rollback support, and the copied <code>formaspecctl</code> command.</span></div></div>
              {busy === "validate-backup-import" && <div className="administration-empty"><LoaderCircle size={20} className="spin" /> Verifying the selected full backup…</div>}
              {backupImportValidation && backupFile && <div className="backup-import-result">
                <div><ShieldCheck size={20} /><span><strong>{backupFile.name}</strong><small>Database schema {backupImportValidation.manifest.databaseSchemaVersion} · {backupImportValidation.manifest.fileCount} files · {fileSize(backupImportValidation.sizeBytes)}</small><code>SHA-256 {backupImportValidation.bundleSha256}</code></span></div>
                <button className="button button-primary" disabled={busy !== null} onClick={() => void run("register-backup-import", async () => {
                  const imported = await registerBackupImport(backupFile, backupImportValidation.bundleSha256);
                  setBackups((current) => [imported.backup, ...current.filter((item) => item.id !== imported.backup.id)]);
                  setNotice(imported.alreadyRegistered
                    ? `${imported.backup.filename} was already registered and remains ready for supervised restore.`
                    : `${imported.backup.filename} was verified and added to managed backups. No live data was replaced.`);
                  setBackupFile(null);
                  setBackupImportValidation(null);
                })}>{busy === "register-backup-import" ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} Add to managed backups</button>
              </div>}
            </div>
            <div className="administration-list">
              {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading backup records…</div> : backups.length === 0 ? (
                <div className="administration-empty"><FileArchive size={24} /><strong>No managed backups yet</strong><span>Create one before migrations or important project changes.</span></div>
              ) : backups.map((backup) => (
                <article className="administration-row" key={backup.id}>
                  <div className={`status-icon is-${backup.status}`}>{backup.status === "valid" ? <ShieldCheck size={16} /> : <XCircle size={16} />}</div>
                  <div className="administration-row-main">
                    <strong>{backup.filename}</strong>
                    <span>{fileSize(backup.sizeBytes)} · Created {dateTime(backup.createdAt)} · Verified {dateTime(backup.verifiedAt)}</span>
                    <code>{backup.bundleSha256 ?? "Checksum unavailable"}</code>
                  </div>
                  <div className="administration-row-actions">
                    <button className="icon-button" title="Verify again" disabled={busy !== null} onClick={() => void run(`verify-${backup.id}`, async () => {
                      const verified = await verifyBackup(backup.id);
                      setBackups((current) => current.map((item) => item.id === verified.id ? verified : item));
                      setNotice(`${verified.filename} passed verification.`);
                    })}>{busy === `verify-${backup.id}` ? <LoaderCircle size={14} className="spin" /> : <RefreshCcw size={14} />}</button>
                    {backup.status === "valid" && <a className="icon-button" href={backupDownloadUrl(backup.id)} title="Download verified backup"><Download size={14} /></a>}
                    {backup.status === "valid" && <button className="icon-button" title="Copy managed restore command" aria-label={`Copy restore command for ${backup.filename}`} disabled={busy !== null} onClick={() => void run(`restore-command-${backup.id}`, async () => {
                      await copyText(managedBackupRestoreCommand(backup.id));
                      setNotice(`Restore command copied for ${backup.filename}. Run it on the FormaSpec host after reviewing the selected backup ID.`);
                    })}>{busy === `restore-command-${backup.id}` ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}</button>}
                  </div>
                </article>
              ))}
            </div>
          </section>}

          {section === "agents" && canAdministerOrganization !== false && <section className="administration-card">
            <div className="administration-card-heading">
              <div><span><Bot size={18} /></span><div><h2>FormaSpec MCP for Codex</h2><p>One click creates a scoped pairing request and opens the installed FormaSpec handler. Agent tasks are created only in Codex or the CLI.</p></div></div>
              <button className="button button-primary" disabled={busy !== null} onClick={() => void connectCodex()}>{busy === "connect-codex" ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />} {activeConnection ? "Reconnect FormaSpec MCP" : "Install / connect FormaSpec MCP"}</button>
            </div>
            {!pairingLink && <div className="pairing-link"><KeyRound size={13} /><span>This managed connection is the only website action needed. Once connected, mention <code>[@FormaSpec](plugin://formaspec@formaspec)</code> in Codex or use the CLI.</span></div>}
            {pairingLink && <details className="agent-connection-history">
              <summary>Connection handler did not open? <span>Retry or use the expiring CLI fallback</span></summary>
              <div>
                <div className="pairing-link"><ExternalLink size={13} /><span>Retry the exact one-time connection link.</span><button className="button button-secondary" onClick={() => openCodexPairingLink(pairingLink)}>Retry connection</button></div>
                {pairingCommand && <div className="agent-install-command">
                  <code>{pairingCommand}</code>
                  <button className="icon-button" title="Copy one-time pairing command" aria-label="Copy one-time Codex pairing command" onClick={() => void copyText(pairingCommand).then(() => setNotice("One-time Codex pairing command copied."))}><Copy size={14} /></button>
                </div>}
              </div>
            </details>}
            <div className="administration-list">
              {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading agent connections…</div> : connections.length === 0 ? (
                <div className="administration-empty"><Bot size={24} /><strong>No connected agents</strong><span>Connect Codex once, then mention [@FormaSpec](plugin://formaspec@formaspec).</span></div>
              ) : <>
                {connectionGroups.current.length === 0 && <div className="administration-empty is-compact"><Bot size={20} /><strong>No current FormaSpec connection</strong><span>Reconnect Codex to activate a scoped agent grant.</span></div>}
                {connectionGroups.current.map(renderAgentConnection)}
                {connectionGroups.history.length > 0 && <details className="agent-connection-history">
                  <summary>Connection history <span>{connectionGroups.history.length} revoked or expired</span></summary>
                  <div>{connectionGroups.history.map(renderAgentConnection)}</div>
                </details>}
              </>}
            </div>
          </section>}

          {section === "design-system" && <section className="administration-card">
            <div className="administration-card-heading">
              <div><span><Palette size={18} /></span><div><h2>Design systems</h2><p>Versioned organization tokens, components, releases, and project pins.</p></div></div>
            </div>
            {canAdministerOrganization !== false && <div className="design-system-create-row">
              <input value={designSystemName} onChange={(event) => setDesignSystemName(event.target.value)} maxLength={240} aria-label="Design-system name" />
              <button className="button button-primary" disabled={busy !== null || !designSystemName.trim()} onClick={() => void run("create-system", async () => {
                const created = await createOrganizationDesignSystem({
                  name: designSystemName.trim(),
                  description: "Organization-owned FormaSpec tokens, components, and immutable releases.",
                });
                setDesignSystems((current) => [created, ...current]);
                setDesignSystemName("Company Design System");
                setNotice(`${created.name} was created. Add versioned tokens/components, then publish an immutable release through the API or FormaSpec agent tools.`);
              })}>{busy === "create-system" ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Create</button>
            </div>}
            <div className="administration-list">
              {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading design systems…</div> : designSystems.length === 0 ? (
                <div className="administration-empty"><Palette size={24} /><strong>No organization design system</strong><span>The bundled FormaSpec Foundation System remains available to every project.</span></div>
              ) : designSystems.map((system) => (
                <article className="administration-row" key={system.id}>
                  <div className={`status-icon is-${system.status === "active" ? "valid" : "revoked"}`}><Palette size={16} /></div>
                  <div className="administration-row-main">
                    <strong>{system.name}</strong>
                    <span>{system.status} · Updated {dateTime(system.updatedAt)}</span>
                    <small>{system.description || "No description"}</small>
                    <code>{system.id}</code>
                  </div>
                </article>
              ))}
            </div>
          </section>}

          {section === "design-system" && <DesignSystemProjectPins
            designSystems={designSystems}
            canAdminister={canAdministerOrganization !== false}
            onNotice={reportNotice}
            onError={reportError}
          />}

          {section === "policy" && canAdministerOrganization !== false && <OrganizationPolicyEditor
            record={organizationPolicy}
            loading={loading}
            disabled={busy !== null}
            saving={busy === "save-organization-policy"}
            onError={reportError}
            onDirtyChange={setPolicyDirty}
            onSave={async (expectedConfigurationHash, policy) => {
              await run("save-organization-policy", async () => {
                const updated = await updateOrganizationPolicy(expectedConfigurationHash, policy);
                setOrganizationPolicy(updated);
                setNotice("Organization policy was validated, saved, audited, and applied.");
              });
            }}
          />}
        </div>}

        {section === "design-system" && <DesignSystemComponentAuthoring designSystems={designSystems.filter((system) => system.status === "active")} />}

        {section === "imports" && canAdministerOrganization !== false && <section className="administration-card import-validator-card" id="project-import" aria-labelledby="project-recovery-title">
          <div className="administration-card-heading">
            <div><span><Upload size={18} /></span><div><h2 id="project-recovery-title">Import one editable project</h2><p>Non-destructive V1 or V2 project import: choose a local .formaspec.zip bundle, validate it without mutation, then preserve IDs or create a deterministic clone.</p></div></div>
            <label className={`button button-secondary ${busy ? "is-disabled" : ""}`}><Upload size={14} /> Select .formaspec.zip<input type="file" accept=".zip,.formaspec.zip,application/zip" hidden disabled={busy !== null} onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              setPortableFile(file);
              setValidation(null);
              void run("validate-import", async () => {
                const result = await validatePortableImport(file);
                setValidation(result);
                setNotice(`${file.name} is structurally valid and ready to import. No data has changed yet.`);
              });
            }} /></label>
          </div>
          <div className="safe-import-boundary"><ShieldCheck size={16} /><div><strong>Project import is different from full restore</strong><span>This creates one editable project and never replaces the workspace database. FormaSpec reads only the archive selected with this file picker, applies bounded archive validation, and never accepts or sends an arbitrary server filesystem path.</span></div></div>
          {busy === "validate-import" && <div className="administration-empty"><LoaderCircle size={20} className="spin" /> Validating the bounded archive…</div>}
          {validation && <div className="validation-summary">
            <ShieldCheck size={22} />
            <div><strong>{validation.project.name ?? validation.project.id ?? "Validated project"}</strong><span>Schema V{validation.project.schemaVersion} · {validation.project.pageCount} pages · {validation.project.nodeCount} nodes · {validation.project.assetCount} assets · {validation.project.previewCount} previews</span><small>Validated only. Choose the import behavior below; the final write is one atomic transaction.</small></div>
          </div>}
          {validation && portableFile && <div className="portable-import-controls">
            <label>
              <span>Import behavior</span>
              <select value={portableImportMode} disabled={busy !== null} onChange={(event) => setPortableImportMode(event.target.value as PortableImportMode)}>
                <option value="conflict_fail">Preserve IDs — fail on any conflict</option>
                <option value="clone">Clone — deterministically remap project IDs</option>
              </select>
              <small>{portableImportMode === "conflict_fail"
                ? "Best for restoring or moving a project into a workspace where its project and asset IDs do not already exist."
                : "Best for importing another copy into the same workspace. Organization-global design-system pins stay unchanged."}</small>
            </label>
            <button className="button button-primary" disabled={busy !== null} onClick={() => void run("commit-import", async () => {
              const imported = await importPortableProject(portableFile, portableImportMode);
              setNotice(`${imported.project.name} was imported as local revision 1.`);
              navigate(imported.deepLink);
            })}>{busy === "commit-import" ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} Import project</button>
          </div>}
        </section>}
        </section>
      </div>
    </main>
  );
}
