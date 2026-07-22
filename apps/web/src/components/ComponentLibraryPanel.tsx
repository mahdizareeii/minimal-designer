import type { ComponentDefinition } from "@designer/core";
import {
  Boxes,
  CheckCircle2,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isNodeContainer,
  pageIdForNode,
  createClientKey,
  type DesignDocument,
  type NodeId,
  type PageId,
  type ParentReference,
} from "../domain";
import {
  commitComponentInsertionPreview,
  createComponentInsertionPreview,
  exactPreviewRenderUrl,
  readComponentLibrary,
  renderUrl,
  type ComponentInsertionPreviewRecord,
  type ComponentLibraryRecord,
} from "../lib/api";
import { useDesignerStore } from "../store/designer-store";

export interface ComponentInsertionParentOption {
  key: string;
  label: string;
  parent: ParentReference;
  acceptsPosition: boolean;
}

export function componentInsertionParentOptions(
  document: DesignDocument,
  activePageId: PageId | null,
  selectedIds: readonly NodeId[],
): ComponentInsertionParentOption[] {
  const page = document.pages.find((candidate) => candidate.id === activePageId && !candidate.archived)
    ?? document.pages.find((candidate) => !candidate.archived);
  if (!page) return [];
  const selected = new Set(selectedIds);
  const containers = Object.values(document.nodes)
    .filter((node) => !node.archived
      && !node.locked
      && isNodeContainer(node)
      && pageIdForNode(document, node.id) === page.id)
    .sort((left, right) => Number(selected.has(right.id)) - Number(selected.has(left.id))
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id));
  return [
    {
      key: `page:${page.id}`,
      label: `Page · ${page.name}`,
      parent: { page_id: page.id },
      acceptsPosition: true,
    },
    ...containers.map((node) => ({
      key: `node:${node.id}`,
      label: `${node.type === "frame" ? "Frame" : "Container"} · ${node.name}`,
      parent: { node_id: node.id },
      acceptsPosition: node.layout.mode === "absolute",
    })),
  ];
}

function defaultParentKey(options: readonly ComponentInsertionParentOption[], selectedIds: readonly NodeId[]): string {
  const selected = new Set(selectedIds);
  return options.find((option) => "node_id" in option.parent && selected.has(option.parent.node_id))?.key
    ?? options[0]?.key
    ?? "";
}

function defaultState(definition: ComponentDefinition | undefined): ComponentDefinition["states"][number]["key"] {
  return definition?.states.find((state) => state.key === "default")?.key
    ?? definition?.states[0]?.key
    ?? "default";
}

export function ComponentLibraryPanel() {
  const document = useDesignerStore((state) => state.document);
  const baseVersion = useDesignerStore((state) => state.baseVersion);
  const activePageId = useDesignerStore((state) => state.activePageId);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const pendingCount = useDesignerStore((state) => state.pendingOperations.length);
  const saving = useDesignerStore((state) => state.saving);
  const saveState = useDesignerStore((state) => state.saveState);
  const conflictRecovery = useDesignerStore((state) => state.conflictRecovery);
  const openDesign = useDesignerStore((state) => state.openDesign);
  const select = useDesignerStore((state) => state.select);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const [library, setLibrary] = useState<ComponentLibraryRecord | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [componentId, setComponentId] = useState("");
  const [activeState, setActiveState] = useState<ComponentDefinition["states"][number]["key"]>("default");
  const [parentKey, setParentKey] = useState("");
  const [position, setPosition] = useState({ x: 64, y: 64 });
  const [instanceName, setInstanceName] = useState("");
  const [preview, setPreview] = useState<ComponentInsertionPreviewRecord | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const designId = document?.id ?? "";

  const loadLibrary = useCallback(async () => {
    if (!designId) return;
    setLibraryLoading(true);
    setError(null);
    try {
      const next = await readComponentLibrary(designId);
      setLibrary(next);
      setComponentId((current) => next.components.some((component) => component.definition.id === current)
        ? current
        : next.components.find((component) => component.insertable)?.definition.id
          ?? next.components[0]?.definition.id
          ?? "");
    } catch (cause) {
      setLibrary(null);
      setError(cause instanceof Error ? cause.message : "The pinned component library could not be loaded.");
    } finally {
      setLibraryLoading(false);
    }
  }, [designId]);

  useEffect(() => {
    setPreview(null);
    void loadLibrary();
  }, [baseVersion, loadLibrary]);

  const parentOptions = useMemo(() => document
    ? componentInsertionParentOptions(document, activePageId, selectedIds)
    : [], [activePageId, document, selectedIds]);

  useEffect(() => {
    setParentKey((current) => parentOptions.some((option) => option.key === current)
      ? current
      : defaultParentKey(parentOptions, selectedIds));
  }, [parentOptions, selectedIds]);

  const component = library?.components.find((candidate) => candidate.definition.id === componentId);
  useEffect(() => {
    setActiveState(defaultState(component?.definition));
    setPreview(null);
  }, [componentId, component?.definition.version]);

  const parent = parentOptions.find((option) => option.key === parentKey);
  const cleanHead = pendingCount === 0
    && !saving
    && saveState === "saved"
    && conflictRecovery === null
    && library?.baseVersion === baseVersion;
  const canPreview = Boolean(component?.insertable && parent && cleanHead && !libraryLoading && busy === null);

  const createPreview = async () => {
    if (!designId || !component || !parent || !canPreview) return;
    if (parent.acceptsPosition && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) {
      setError("Component position must use finite X and Y values.");
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const next = await createComponentInsertionPreview({
        designId,
        baseVersion,
        componentDefinitionId: component.definition.id,
        parent: parent.parent,
        activeState,
        ...(parent.acceptsPosition ? { position } : {}),
        ...(instanceName.trim() ? { name: instanceName.trim() } : {}),
      });
      setPreview(next);
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "The exact component preview could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const commitPreview = async () => {
    if (!designId || !preview || !preview.canCommit || preview.status !== "ready" || !cleanHead) return;
    setBusy("commit");
    setError(null);
    const insertedInstanceId = preview.component.instanceId as NodeId;
    try {
      const committed = await commitComponentInsertionPreview({
        designId,
        previewId: preview.previewId,
        expectedBaseVersion: preview.rootBaseVersion,
        idempotencyKey: createClientKey("component_insert"),
        message: `Insert ${component?.definition.name ?? "verified component"}`,
      });
      await openDesign(designId);
      const latest = useDesignerStore.getState();
      if (latest.document?.nodes[insertedInstanceId]) select([insertedInstanceId]);
      setPreview(null);
      setInstanceName("");
      setNotice(`Inserted ${component?.definition.name ?? "component"} in revision ${committed.version}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The exact component preview could not be committed.");
    } finally {
      setBusy(null);
    }
  };

  if (!document) return null;

  return (
    <section className="component-library-panel" aria-label="Pinned component library">
      <header>
        <div><span><Boxes size={13} /></span><div><strong>Pinned library</strong><small>{library ? `${library.releaseName} · v${library.releaseVersion}` : "Exact release components"}</small></div></div>
        <button className="icon-button" disabled={libraryLoading || busy !== null} onClick={() => void loadLibrary()} aria-label="Refresh component library"><RefreshCw size={11} className={libraryLoading ? "spin" : ""} /></button>
      </header>

      {libraryLoading && !library && <div className="component-library-message"><LoaderCircle size={14} className="spin" /><span>Loading the pinned release…</span></div>}
      {error && <div className="component-library-message is-error"><ShieldAlert size={14} /><span>{error}</span></div>}
      {!libraryLoading && !library && !error && <div className="component-library-message"><Sparkles size={14} /><span>Migrate this project to V2 and pin a release to insert linked components.</span></div>}

      {library && library.components.length === 0 && <div className="component-library-message"><Sparkles size={14} /><span>The pinned release contains no components.</span></div>}
      {library && library.components.length > 0 && (
        <div className="component-library-controls">
          <label><span>Component</span><select value={componentId} disabled={busy !== null} onChange={(event) => setComponentId(event.target.value)}>{library.components.map((candidate) => <option value={candidate.definition.id} key={`${candidate.definition.id}:${candidate.definition.version}`}>{candidate.definition.name} · v{candidate.definition.version}{candidate.insertable ? "" : " · blocked"}</option>)}</select></label>
          {component && <div className={`component-library-source ${component.insertable ? "is-ready" : "is-blocked"}`}>
            {component.insertable ? <CheckCircle2 size={12} /> : <ShieldAlert size={12} />}
            <span><strong>{component.definition.key}</strong><small>{component.sourceHash ? `${component.sourceNodeCount} source nodes · ${component.sourceHash.slice(0, 10)}…` : "No verified source"}</small></span>
          </div>}
          {component && component.blockers.map((blocker) => <div className="component-library-blocker" key={blocker.code}><ShieldAlert size={11} /><span>{blocker.message}</span></div>)}
          {component && component.definition.states.length > 1 && <label><span>State</span><select value={activeState} disabled={busy !== null} onChange={(event) => { setActiveState(event.target.value as typeof activeState); setPreview(null); }}>{component.definition.states.map((state) => <option value={state.key} key={state.key}>{state.name}</option>)}</select></label>}
          <label><span>Insert into</span><select value={parentKey} disabled={busy !== null || parentOptions.length === 0} onChange={(event) => { setParentKey(event.target.value); setPreview(null); }}>{parentOptions.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}</select></label>
          {parent?.acceptsPosition && <div className="component-library-position"><label><span>X</span><input type="number" value={position.x} onChange={(event) => { setPosition((current) => ({ ...current, x: Number(event.target.value) })); setPreview(null); }} /></label><label><span>Y</span><input type="number" value={position.y} onChange={(event) => { setPosition((current) => ({ ...current, y: Number(event.target.value) })); setPreview(null); }} /></label></div>}
          <label><span>Instance name <i>optional</i></span><input maxLength={160} value={instanceName} placeholder={component?.definition.name ?? "Component"} onChange={(event) => { setInstanceName(event.target.value); setPreview(null); }} /></label>
          {!cleanHead && <div className="component-library-blocker"><ShieldAlert size={11} /><span>{library.baseVersion !== baseVersion ? "The library is stale; refresh the project first." : "Save or resolve the current editor draft before creating a server preview."}</span></div>}
          <button className="button button-secondary component-library-preview-button" disabled={!canPreview} onClick={() => void createPreview()}>{busy === "preview" ? <LoaderCircle size={12} className="spin" /> : <Eye size={12} />} Create exact preview</button>
        </div>
      )}

      {preview && <div className={`component-insertion-preview is-${preview.status}`}>
        <div className="component-insertion-preview-image"><img src={exactPreviewRenderUrl(designId, preview.previewId)} alt={`Exact preview of ${component?.definition.name ?? "component"} insertion`} /></div>
        <div className="component-insertion-preview-summary">
          <span><strong>{preview.canCommit ? "Ready to commit" : "Preview blocked"}</strong><small>v{preview.rootBaseVersion} → v{preview.proposedVersion} · {preview.changedNodeIds.length} changed</small></span>
          <code title={preview.resultSnapshotHash}>{preview.resultSnapshotHash.slice(0, 12)}…</code>
        </div>
        {preview.diagnostics.length > 0 && <div className="component-insertion-diagnostics">{preview.diagnostics.slice(0, 6).map((diagnostic, index) => <div className={`is-${diagnostic.severity}`} key={`${diagnostic.code}:${diagnostic.nodeId ?? index}`}><ShieldAlert size={10} /><span><strong>{diagnostic.code.replaceAll("_", " ")}</strong><small>{diagnostic.message}</small></span></div>)}</div>}
        <div className="component-insertion-preview-actions">
          <button className="button button-secondary" disabled={busy !== null} onClick={() => setPreview(null)}><X size={11} /> Discard</button>
          <button className="button button-primary" disabled={!preview.canCommit || preview.status !== "ready" || !cleanHead || busy !== null} onClick={() => void commitPreview()}>{busy === "commit" ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />} Commit insertion</button>
        </div>
        <a href={renderUrl(designId, { version: baseVersion, pageId: activePageId ?? undefined, maxSize: 720 })} target="_blank" rel="noreferrer">Open current rendered version</a>
      </div>}
    </section>
  );
}
