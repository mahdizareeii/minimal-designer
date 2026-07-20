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
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { navigate } from "../App";
import { DesignSystemComponentAuthoring } from "./DesignSystemComponentAuthoring";
import {
  backupDownloadUrl,
  createBackup,
  createCodexConnection,
  createOrganizationDesignSystem,
  importPortableProject,
  listAgentConnections,
  listBackups,
  listDesignSystems,
  organizationConfigurationUrl,
  readOrganizationPolicy,
  reconnectAgentConnection,
  revokeAgentConnection,
  validatePortableImport,
  verifyBackup,
  updateOrganizationPolicy,
  ApiError,
  type AgentConnectionRecord,
  type AgentPairingChallenge,
  type BackupRecord,
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

function openPairingChallenge(challenge: AgentPairingChallenge): string {
  const url = new URL("formaspec://connect-agent");
  url.searchParams.set("connection", challenge.connection.id);
  url.searchParams.set("nonce", challenge.nonce);
  window.location.href = url.toString();
  return url.toString();
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
  const [pairingLink, setPairingLink] = useState<string | null>(null);
  const [organizationPolicy, setOrganizationPolicy] = useState<OrganizationPolicyRecord | null>(null);
  const [organizationPolicyText, setOrganizationPolicyText] = useState("");
  const [canAdministerOrganization, setCanAdministerOrganization] = useState<boolean | null>(null);

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
        setOrganizationPolicyText("");
      } else {
        if (backupsResult.status === "rejected") throw backupsResult.reason;
        if (connectionsResult.status === "rejected") throw connectionsResult.reason;
        if (policyResult.status === "rejected") throw policyResult.reason;
        setBackups(backupsResult.value);
        setConnections(connectionsResult.value);
        setOrganizationPolicy(policyResult.value);
        setOrganizationPolicyText(JSON.stringify(policyResult.value.policy, null, 2));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Administration data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The operation failed."); }
    finally { setBusy(null); }
  };

  const connectCodex = async () => {
    if (!window.confirm("Authorize Codex with scoped FormaSpec design, product-specification, planning, and task access for 24 hours?")) return;
    await run("connect-codex", async () => {
      const challenge = await createCodexConnection();
      setPairingLink(openPairingChallenge(challenge));
      setNotice("The one-time Codex pairing request was opened. If no handler opens, use the installer command shown below.");
      await refresh();
    });
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
              <div><span><DatabaseBackup size={18} /></span><div><h2>Verified backups</h2><p>SQLite online snapshots, assets, manifests, and checksums.</p></div></div>
              <button className="button button-primary" disabled={busy !== null} onClick={() => void run("create-backup", async () => {
                const backup = await createBackup();
                setBackups((current) => [backup, ...current.filter((item) => item.id !== backup.id)]);
                setNotice(`Backup ${backup.filename} was created and verified.`);
              })}>{busy === "create-backup" ? <LoaderCircle size={14} className="spin" /> : <DatabaseBackup size={14} />} Create backup</button>
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
                  </div>
                </article>
              ))}
            </div>
          </section>}

          {canAdministerOrganization !== false && <section className="administration-card">
            <div className="administration-card-heading">
              <div><span><Bot size={18} /></span><div><h2>Agent Connections</h2><p>Scoped, expiring, revocable machine identities.</p></div></div>
              <button className="button button-primary" disabled={busy !== null} onClick={() => void connectCodex()}>{busy === "connect-codex" ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />} Connect Codex</button>
            </div>
            <div className="agent-install-command">
              <code>pnpm formaspecctl --yes agent connect codex</code>
              <button className="icon-button" title="Copy installer command" onClick={() => void copyText("pnpm formaspecctl --yes agent connect codex").then(() => setNotice("Codex connection command copied."))}><Copy size={14} /></button>
            </div>
            {pairingLink && <div className="pairing-link"><ExternalLink size={13} /><span>One-time pairing link issued. It expires quickly and contains no bearer grant.</span></div>}
            <div className="administration-list">
              {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading agent connections…</div> : connections.length === 0 ? (
                <div className="administration-empty"><Bot size={24} /><strong>No connected agents</strong><span>Connect Codex once, then mention [@Minimal UI](plugin://minimal-ui@formaspec).</span></div>
              ) : connections.map((connection) => (
                <article className="administration-row" key={connection.id}>
                  <div className={`status-icon is-${connection.status}`}>{connection.status === "active" ? <CheckCircle2 size={16} /> : <Bot size={16} />}</div>
                  <div className="administration-row-main">
                    <strong>{connection.displayName}</strong>
                    <span>{connection.status} · Expires {dateTime(connection.expiresAt)} · Last used {dateTime(connection.lastUsedAt)}</span>
                    <small>{connection.scopes.join(" · ")}</small>
                    <small>{connection.projectIds.length > 0 ? `${connection.projectIds.length} restricted projects` : "All projects in this organization"}</small>
                  </div>
                  <div className="administration-row-actions">
                    {connection.status !== "revoked" && <button className="icon-button" title="Reconnect" disabled={busy !== null} onClick={() => void run(`reconnect-${connection.id}`, async () => {
                      const challenge = await reconnectAgentConnection(connection.id);
                      setPairingLink(openPairingChallenge(challenge));
                      setNotice("A new one-time pairing request was opened.");
                      await refresh();
                    })}><RefreshCcw size={14} /></button>}
                    {connection.status !== "revoked" && <button className="icon-button is-danger" title="Revoke immediately" disabled={busy !== null} onClick={() => {
                      if (!window.confirm(`Revoke ${connection.displayName} and all of its active grants immediately?`)) return;
                      void run(`revoke-${connection.id}`, async () => {
                        const revoked = await revokeAgentConnection(connection.id);
                        setConnections((current) => current.map((item) => item.id === revoked.id ? revoked : item));
                        setNotice(`${revoked.displayName} was revoked.`);
                      });
                    }}><Trash2 size={14} /></button>}
                  </div>
                </article>
              ))}
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
                setNotice(`${created.name} was created. Add versioned tokens/components, then publish an immutable release through the API or Minimal UI tools.`);
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

          {canAdministerOrganization !== false && <section className="administration-card organization-policy-card">
            <div className="administration-card-heading">
              <div><span><Settings2 size={18} /></span><div><h2>Organization policy</h2><p>Secret-free, versioned defaults and enforced agent/repository boundaries.</p></div></div>
              <div className="organization-policy-actions">
                <a className="button button-secondary" href={organizationConfigurationUrl()} download="organization.formaspec.yaml"><Download size={14} /> Export YAML</a>
                <button className="button button-primary" disabled={busy !== null || !organizationPolicy} onClick={() => {
                  if (!organizationPolicy) return;
                  let parsed: unknown;
                  try { parsed = JSON.parse(organizationPolicyText) as unknown; }
                  catch { setError("Organization policy JSON is not valid."); return; }
                  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    setError("Organization policy must be a JSON object.");
                    return;
                  }
                  if (!window.confirm("Save this organization policy? New and existing agent grants and repository uploads will be checked against it immediately.")) return;
                  void run("save-organization-policy", async () => {
                    const updated = await updateOrganizationPolicy(
                      organizationPolicy.configurationHash,
                      parsed as Record<string, unknown>,
                    );
                    setOrganizationPolicy(updated);
                    setOrganizationPolicyText(JSON.stringify(updated.policy, null, 2));
                    setNotice("Organization policy was validated, saved, audited, and applied.");
                  });
                }}>{busy === "save-organization-policy" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Save policy</button>
              </div>
            </div>
            {organizationPolicy ? <div className="organization-policy-editor">
              <div className="organization-policy-meta">
                <span>Source: <strong>{organizationPolicy.source.replaceAll("_", " ")}</strong></span>
                <span>Policy SHA-256: <code>{organizationPolicy.policyHash}</code></span>
                <span>Updated {dateTime(organizationPolicy.updatedAt)}</span>
              </div>
              {organizationPolicy.diagnostics.map((diagnostic) => (
                <div className={`administration-alert is-${diagnostic.severity}`} key={diagnostic.code}><ShieldCheck size={14} /><span>{diagnostic.message}</span></div>
              ))}
              <textarea
                aria-label="Organization policy JSON"
                spellCheck={false}
                value={organizationPolicyText}
                onChange={(event) => setOrganizationPolicyText(event.target.value)}
              />
              <small>No passwords, bearer grants, Keychain values, repository paths, or signing credentials are accepted or exported by this policy schema.</small>
            </div> : <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading organization policy…</div>}
          </section>}
        </div>

        <DesignSystemComponentAuthoring designSystems={designSystems.filter((system) => system.status === "active")} />

        {canAdministerOrganization !== false && <section className="administration-card import-validator-card">
          <div className="administration-card-heading">
            <div><span><Upload size={18} /></span><div><h2>Portable project import</h2><p>Validate first, then preserve IDs with atomic conflict failure or create a deterministic clone.</p></div></div>
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
