import { ArrowUpCircle, CheckCircle2, LoaderCircle, Palette, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { DesignProjectSummary } from "../domain";
import {
  ApiError,
  commitProjectDesignSystemUpgrade,
  listDesigns,
  listDesignSystemReleases,
  pinProjectDesignSystem,
  previewProjectDesignSystemUpgrade,
  readProjectDesignSystemPin,
  type DesignSystemRecord,
  type DesignSystemReleaseRecord,
  type DesignSystemUpgradePreviewRecord,
  type ProjectDesignSystemPinRecord,
} from "../lib/api";

export function eligibleDesignSystemReleases(
  releases: readonly DesignSystemReleaseRecord[],
  pin: ProjectDesignSystemPinRecord | null,
): DesignSystemReleaseRecord[] {
  return releases
    .filter((release) => release.status === "published"
      && (!pin || (release.designSystemId === pin.designSystemId && release.version > pin.releaseVersion)))
    .sort((left, right) => right.version - left.version || left.id.localeCompare(right.id));
}

export function projectPinActionsDisabled(input: {
  canAdminister: boolean;
  selectedTarget: DesignSystemReleaseRecord | null;
  busy: "pin" | "preview" | "commit" | null;
  pinLoading: boolean;
  releasesLoading: boolean;
}): boolean {
  return !input.canAdminister
    || !input.selectedTarget
    || input.busy !== null
    || input.pinLoading
    || input.releasesLoading;
}

export function DesignSystemProjectPins({
  designSystems,
  canAdminister,
  onNotice,
  onError,
}: {
  designSystems: DesignSystemRecord[];
  canAdminister: boolean;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const activeSystems = useMemo(() => designSystems.filter((system) => system.status === "active"), [designSystems]);
  const [projects, setProjects] = useState<DesignProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  const [systemId, setSystemId] = useState("");
  const [releases, setReleases] = useState<DesignSystemReleaseRecord[]>([]);
  const [releaseId, setReleaseId] = useState("");
  const [pin, setPin] = useState<ProjectDesignSystemPinRecord | null>(null);
  const [preview, setPreview] = useState<DesignSystemUpgradePreviewRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [pinLoading, setPinLoading] = useState(false);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [busy, setBusy] = useState<"pin" | "preview" | "commit" | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listDesigns().then((items) => {
      if (!active) return;
      setProjects(items);
      setProjectId((current) => current || items[0]?.id || "");
    }).catch((cause) => {
      if (active) onError(cause instanceof Error ? cause.message : "Projects could not be loaded for design-system pinning.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onError]);

  useEffect(() => {
    if (!projectId) {
      setPin(null);
      setPreview(null);
      setSystemId("");
      setReleases([]);
      setReleaseId("");
      setPinLoading(false);
      return;
    }
    let active = true;
    setPinLoading(true);
    setPin(null);
    setPreview(null);
    setSystemId("");
    setReleases([]);
    setReleaseId("");
    void readProjectDesignSystemPin(projectId).then((record) => {
      if (!active) return;
      setPin(record);
      setSystemId(record.designSystemId);
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof ApiError && cause.code === "NOT_FOUND") {
        setPin(null);
        setSystemId((current) => activeSystems.some((system) => system.id === current)
          ? current
          : activeSystems[0]?.id ?? "");
        return;
      }
      setPin(null);
      onError(cause instanceof Error ? cause.message : "The project design-system pin could not be read.");
    }).finally(() => { if (active) setPinLoading(false); });
    return () => { active = false; };
  }, [activeSystems, onError, projectId]);

  useEffect(() => {
    if (!systemId) {
      setReleases([]);
      setReleaseId("");
      setReleasesLoading(false);
      return;
    }
    let active = true;
    setReleasesLoading(true);
    setReleases([]);
    setReleaseId("");
    setPreview(null);
    void listDesignSystemReleases(systemId).then((items) => {
      if (!active) return;
      setReleases(items);
      const eligible = eligibleDesignSystemReleases(items, pin);
      setReleaseId((current) => eligible.some((release) => release.id === current)
        ? current
        : eligible[0]?.id ?? "");
    }).catch((cause) => {
      if (active) onError(cause instanceof Error ? cause.message : "Design-system releases could not be loaded.");
    }).finally(() => { if (active) setReleasesLoading(false); });
    return () => { active = false; };
  }, [onError, pin, systemId]);

  const targets = useMemo(() => eligibleDesignSystemReleases(releases, pin), [pin, releases]);
  const currentRelease = pin ? releases.find((release) => release.id === pin.releaseId) ?? null : null;
  const selectedTarget = targets.find((release) => release.id === releaseId) ?? null;
  const actionsDisabled = projectPinActionsDisabled({
    canAdminister,
    selectedTarget,
    busy,
    pinLoading,
    releasesLoading,
  });

  const refreshPin = useCallback(async () => {
    if (!projectId) return;
    const record = await readProjectDesignSystemPin(projectId);
    setPin(record);
    setSystemId(record.designSystemId);
  }, [projectId]);

  const createPin = async () => {
    if (!projectId || !releaseId || pin) return;
    setBusy("pin");
    try {
      const next = await pinProjectDesignSystem({ designId: projectId, releaseId, expectedCurrentReleaseId: null });
      setPin(next);
      setSystemId(next.designSystemId);
      setPreview(null);
      onNotice(`Pinned ${projects.find((project) => project.id === projectId)?.name ?? "project"} to release ${next.releaseVersion}.`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The project could not be pinned.");
    } finally {
      setBusy(null);
    }
  };

  const createPreview = async () => {
    if (!projectId || !releaseId || !pin) return;
    setBusy("preview");
    try {
      const next = await previewProjectDesignSystemUpgrade({ designId: projectId, targetReleaseId: releaseId });
      setPreview(next);
      onNotice(next.canCommit
        ? "The exact design-system upgrade preview is ready for review."
        : "The upgrade preview contains blocking diagnostics and cannot be committed.");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The design-system upgrade preview could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const commitPreview = async () => {
    if (!preview || !preview.canCommit) return;
    setBusy("commit");
    try {
      const committed = await commitProjectDesignSystemUpgrade({
        previewId: preview.id,
        expectedPreviewHash: preview.previewHash,
      });
      setPreview(committed.preview);
      await refreshPin();
      onNotice(`Project design-system pin upgraded to release ${committed.pin.releaseVersion}.`);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The exact upgrade preview could not be committed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="administration-card design-system-pin-card">
      <div className="administration-card-heading">
        <div><span><ArrowUpCircle size={18} /></span><div><h2>Project release pins</h2><p>Pin a published release once, then use exact diagnostic previews for every upgrade.</p></div></div>
      </div>
      {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading project pins…</div> : projects.length === 0 ? (
        <div className="administration-empty"><Palette size={24} /><strong>No projects available</strong><span>Create a project before assigning an organization design-system release.</span></div>
      ) : (
        <div className="design-system-pin-workspace">
          <div className="design-system-pin-controls">
            <label><span>Project</span><select value={projectId} disabled={busy !== null} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option value={project.id} key={project.id}>{project.name} · v{project.version}</option>)}</select></label>
            <label><span>Design system</span><select value={systemId} disabled={busy !== null || pinLoading || Boolean(pin)} onChange={(event) => setSystemId(event.target.value)}><option value="">{pinLoading ? "Loading project pin…" : "Choose a system…"}</option>{activeSystems.map((system) => <option value={system.id} key={system.id}>{system.name}</option>)}</select></label>
            <label><span>{pin ? "Upgrade target" : "Published release"}</span><select value={releaseId} disabled={busy !== null || pinLoading || releasesLoading} onChange={(event) => { setReleaseId(event.target.value); setPreview(null); }}><option value="">{pinLoading || releasesLoading ? "Loading published releases…" : pin ? "No newer published release" : "Choose a published release…"}</option>{targets.map((release) => <option value={release.id} key={release.id}>v{release.version} · {release.name}</option>)}</select></label>
            <button className="button button-primary" disabled={actionsDisabled} onClick={() => void (pin ? createPreview() : createPin())}>
              {busy === "pin" || busy === "preview" ? <LoaderCircle size={13} className="spin" /> : pin ? <ShieldAlert size={13} /> : <Palette size={13} />}
              {pin ? "Preview upgrade" : "Pin release"}
            </button>
          </div>

          <div className="design-system-pin-current">
            <span className={`status-icon ${pin ? "is-valid" : "is-pending"}`}>{pinLoading ? <LoaderCircle className="spin" size={15} /> : pin ? <CheckCircle2 size={15} /> : <Palette size={15} />}</span>
            <div><strong>{pinLoading ? "Loading the selected project pin…" : pin ? `Pinned to v${pin.releaseVersion}${currentRelease ? ` · ${currentRelease.name}` : ""}` : "Project is not pinned"}</strong><small>{pinLoading ? "Actions stay disabled until the project pin and its release catalog are both current." : pin ? `Release ${pin.releaseId} · pinned ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(pin.pinnedAt))}` : "Choose any published release. Later changes require preview, diagnostics, and CAS revalidation."}</small></div>
          </div>

          {preview && <div className={`design-system-upgrade-preview is-${preview.status}`}>
            <header><div><strong>{preview.status === "blocked" ? "Upgrade blocked" : preview.status === "committed" ? "Upgrade committed" : "Exact upgrade preview"}</strong><small>Design v{preview.designVersion} · expires {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.expiresAt))}</small>{preview.resultSnapshotHash && <small>Exact snapshot {preview.baseSnapshotHash?.slice(0, 12)} → {preview.resultSnapshotHash.slice(0, 12)}</small>}</div><code>{preview.previewHash}</code></header>
            <div className="design-system-upgrade-diagnostics">
              {preview.diagnostics.length === 0 ? <div className="is-safe"><CheckCircle2 size={13} /><span><strong>No migration diagnostics</strong><small>The release pin can change without component/token review.</small></span></div> : preview.diagnostics.map((diagnostic, index) => (
                <div className={`is-${diagnostic.safety}`} key={`${diagnostic.code}-${diagnostic.entityId ?? index}`}><ShieldAlert size={13} /><span><strong>{diagnostic.code.replaceAll("_", " ")}</strong><small>{diagnostic.message}</small></span></div>
              ))}
            </div>
            <footer><span>Base release {preview.currentReleaseId} → target {preview.targetReleaseId}</span><button className="button button-primary" disabled={!canAdminister || !preview.canCommit || preview.status !== "ready" || busy !== null} onClick={() => void commitPreview()}>{busy === "commit" ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={13} />} Commit exact preview</button></footer>
          </div>}
        </div>
      )}
    </section>
  );
}
