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
import { useCallback, useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
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
  return `pnpm formaspecctl backup restore --backup-id ${backupId} --yes`;
}

function assertSafePairingChallenge(challenge: AgentPairingChallenge): void {
  if (!/^fspair_[A-Za-z0-9_-]{43}$/.test(challenge.nonce)
    || !/^connection_[a-f0-9]{32}$/.test(challenge.connection.id)) {
    throw new Error("The Codex pairing challenge is not safe to place in a command.");
  }
}

export function codexPairingCommand(challenge: AgentPairingChallenge): string {
  assertSafePairingChallenge(challenge);
  return `./designer --yes agent connect codex --pairing-nonce ${challenge.nonce} --connection-id ${challenge.connection.id}`;
}

export function codexPairingLink(challenge: AgentPairingChallenge): string {
  assertSafePairingChallenge(challenge);
  const url = new URL("formaspec://connect-agent");
  url.searchParams.set("connection", challenge.connection.id);
  url.searchParams.set("nonce", challenge.nonce);
  return url.toString();
}

export function agentConnectionDisplayName(connection: Pick<AgentConnectionRecord, "adapter" | "displayName">): string {
  return connection.adapter === "codex" ? "Codex — FormaSpec" : connection.displayName;
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

export function Administration() {
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
  const connectionGroups = useMemo(() => groupAgentConnections(connections), [connections]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [backupsResult, connectionsResult, systemsResult, policyResult] = await Promise.allSettled([
        listBackups(),
        listAgentConnections(),
        listDesignSystems(),
        readOrganizationPolicy(),
      ]);
      if (systemsResult.status === "rejected") throw systemsResult.reason;
      setDesignSystems(systemsResult.value);
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Administration data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
    if (!window.confirm("Authorize Codex for 24 hours with scoped access to organization policy, editor context, designs, product specifications, planning and tasks, design-system reads, workspace inventories, handoffs, and redesign planning/design? Approval, implementation completion, and cancellation remain human-only.")) return;
    await run("connect-codex", async () => {
      const challenge = await createCodexConnection();
      setPairingCommand(codexPairingCommand(challenge));
      setPairingLink(codexPairingLink(challenge));
      setNotice("The one-time FormaSpec pairing request is ready. Click Finish FormaSpec connection below; if the protocol handler is unavailable, use the installer command.");
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
          {connection.status !== "revoked" && <button className="icon-button" title="Reconnect" disabled={busy !== null} onClick={() => void run(`reconnect-${connection.id}`, async () => {
            const challenge = await reconnectAgentConnection(connection.id);
            setPairingCommand(codexPairingCommand(challenge));
            setPairingLink(codexPairingLink(challenge));
            setNotice("A new one-time FormaSpec pairing request is ready. Click Finish FormaSpec connection.");
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
        <button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
        <div className="administration-brand"><span><Sparkles size={16} /></span><div><strong>FormaSpec Administration</strong><small>Backups, portable validation, and agent authorization</small></div></div>
        <button className="icon-button" onClick={() => void refresh()} aria-label="Refresh administration" disabled={loading}><RefreshCcw size={16} className={loading ? "spin" : ""} /></button>
      </header>

      <section className="administration-content">
        {error && <div className="administration-alert is-error"><XCircle size={16} /><span>{error}</span></div>}
        {notice && <div className="administration-alert"><CheckCircle2 size={16} /><span>{notice}</span></div>}
        {canAdministerOrganization === false && <div className="administration-alert"><ShieldCheck size={16} /><span>Limited organization access: Administrator-only policy, backup, agent, import, and system-creation controls are hidden. The server reports your available component-catalog actions below.</span></div>}

        <div className="administration-grid">
          {canAdministerOrganization !== false && <section className="administration-card">
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

          {canAdministerOrganization !== false && <section className="administration-card">
            <div className="administration-card-heading">
              <div><span><Bot size={18} /></span><div><h2>Agent Connections</h2><p>Scoped, expiring, revocable machine identities.</p></div></div>
              <button className="button button-primary" disabled={busy !== null} onClick={() => void connectCodex()}>{busy === "connect-codex" ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />} Connect Codex to FormaSpec</button>
            </div>
            {pairingCommand ? <div className="agent-install-command">
              <code>{pairingCommand}</code>
              <button className="icon-button" title="Copy one-time pairing command" aria-label="Copy one-time Codex pairing command" onClick={() => void copyText(pairingCommand).then(() => setNotice("One-time Codex pairing command copied."))}><Copy size={14} /></button>
            </div> : <div className="pairing-link"><KeyRound size={13} /><span>Choose Connect Codex to FormaSpec to issue the short-lived pairing command required by authenticated FormaSpec.</span></div>}
            {pairingLink && <div className="pairing-link"><ExternalLink size={13} /><span>Pairing is ready. Use this direct click so the browser can open the installed FormaSpec handler; the fallback command expires with it and contains no bearer grant.</span><a className="button button-primary" href={pairingLink}>Finish FormaSpec connection</a></div>}
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

          <section className="administration-card">
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
          </section>

          <DesignSystemProjectPins
            designSystems={designSystems}
            canAdminister={canAdministerOrganization !== false}
            onNotice={reportNotice}
            onError={reportError}
          />

          {canAdministerOrganization !== false && <OrganizationPolicyEditor
            record={organizationPolicy}
            loading={loading}
            disabled={busy !== null}
            saving={busy === "save-organization-policy"}
            onError={reportError}
            onSave={async (expectedConfigurationHash, policy) => {
              await run("save-organization-policy", async () => {
                const updated = await updateOrganizationPolicy(expectedConfigurationHash, policy);
                setOrganizationPolicy(updated);
                setNotice("Organization policy was validated, saved, audited, and applied.");
              });
            }}
          />}
        </div>

        <DesignSystemComponentAuthoring designSystems={designSystems.filter((system) => system.status === "active")} />

        {canAdministerOrganization !== false && <section className="administration-card import-validator-card" id="project-import" aria-labelledby="project-recovery-title">
          <div className="administration-card-heading">
            <div><span><Upload size={18} /></span><div><h2 id="project-recovery-title">Import one editable project</h2><p>Non-destructive project import: choose a local .formaspec.zip bundle, validate it without mutation, then preserve IDs or create a deterministic clone.</p></div></div>
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
    </main>
  );
}
