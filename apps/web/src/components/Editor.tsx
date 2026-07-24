import {
  ArrowLeft,
  Check,
  ChevronDown,
  CloudOff,
  Copy,
  Download,
  Eye,
  FileJson,
  Hand,
  ImageDown,
  LayoutPanelTop,
  LoaderCircle,
  Menu,
  Monitor,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Redo2,
  Save,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { navigate } from "../App";
import { DEVICE_PRESETS, type DevicePreset } from "../domain";
import { exportUrl, portableExportUrl, renderUrl } from "../lib/api";
import { createConflictPatchArtifact } from "../lib/conflict-recovery";
import { CENTER_WORKSPACE_TABS, type CenterWorkspaceTab } from "../lib/editor-information-architecture";
import { useProjectContextPresence } from "../lib/project-context-presence";
import { hasUnsavedDesignerChanges, saveAllDesignerChanges, useDesignerStore } from "../store/designer-store";
import { Canvas, PrototypeCanvas } from "./Canvas";
import { ConflictRecoveryPanel } from "./ConflictRecoveryPanel";
import { InspectorPanel } from "./InspectorPanel";
import { LayersPanel } from "./LayersPanel";
import { ProductBriefPanel } from "./ProductBriefPanel";

const presetIcons = { web: Monitor, phone: Smartphone, tablet: Tablet } as const;

async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Export failed with status ${response.status}.`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function downloadTextFile(contents: string, mediaType: string, filename: string): void {
  const objectUrl = URL.createObjectURL(new Blob([contents], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export function Editor({ designId }: { designId: string }) {
  const document = useDesignerStore((state) => state.document);
  const activePageId = useDesignerStore((state) => state.activePageId);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const loading = useDesignerStore((state) => state.editorLoading);
  const error = useDesignerStore((state) => state.error);
  const offline = useDesignerStore((state) => state.offline);
  const saveState = useDesignerStore((state) => state.saveState);
  const pendingCount = useDesignerStore((state) => state.pendingOperations.length);
  const saving = useDesignerStore((state) => state.saving);
  const tool = useDesignerStore((state) => state.tool);
  const undoCount = useDesignerStore((state) => state.undoStack.length);
  const redoCount = useDesignerStore((state) => state.redoStack.length);
  const notice = useDesignerStore((state) => state.notice);
  const prototypeOpen = useDesignerStore((state) => state.prototypeOpen);
  const prototypePageId = useDesignerStore((state) => state.prototypePageId);
  const sidebarsHidden = useDesignerStore((state) => state.sidebarsHidden);
  const archiveReview = useDesignerStore((state) => state.archiveReview);
  const conflictRecovery = useDesignerStore((state) => state.conflictRecovery);
  const conflictRecoveryDurable = useDesignerStore((state) => state.conflictRecoveryDurable);
  const productBriefGuard = useDesignerStore((state) => state.productBriefGuard);
  const archivedDesignState = useDesignerStore((state) => state.archivedDesignState);
  const openDesign = useDesignerStore((state) => state.openDesign);
  const closeDesign = useDesignerStore((state) => state.closeDesign);
  const connectEvents = useDesignerStore((state) => state.connectEvents);
  const undo = useDesignerStore((state) => state.undo);
  const redo = useDesignerStore((state) => state.redo);
  const loadLatestForConflict = useDesignerStore((state) => state.loadLatestForConflict);
  const duplicateConflictDraft = useDesignerStore((state) => state.duplicateConflictDraft);
  const discardConflictRecovery = useDesignerStore((state) => state.discardConflictRecovery);
  const setTool = useDesignerStore((state) => state.setTool);
  const select = useDesignerStore((state) => state.select);
  const addNode = useDesignerStore((state) => state.addNode);
  const addFrame = useDesignerStore((state) => state.addFrame);
  const duplicate = useDesignerStore((state) => state.duplicateSelection);
  const deleteSelection = useDesignerStore((state) => state.deleteSelection);
  const approveArchiveReview = useDesignerStore((state) => state.approveArchiveReview);
  const discardArchiveReview = useDesignerStore((state) => state.discardArchiveReview);
  const openPrototype = useDesignerStore((state) => state.openPrototype);
  const closePrototype = useDesignerStore((state) => state.closePrototype);
  const goToPrototypePage = useDesignerStore((state) => state.goToPrototypePage);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const setSidebarsHidden = useDesignerStore((state) => state.setSidebarsHidden);
  const [frameMenu, setFrameMenu] = useState(false);
  const [stageTab, setStageTab] = useState<CenterWorkspaceTab>("canvas");
  const [exporting, setExporting] = useState<"json" | "png" | "bundle" | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<"load" | "export" | "duplicate" | "discard" | null>(null);
  const copiedNodeIds = useRef<typeof selectedIds>([]);

  useEffect(() => {
    void openDesign(designId);
    const disconnect = connectEvents();
    return () => {
      disconnect();
      closeDesign();
    };
  }, [designId, openDesign, connectEvents, closeDesign]);

  const contextCanSharePageAndSelection = saveState === "saved"
    && pendingCount === 0
    && !archiveReview
    && !conflictRecovery;
  const projectContextPresence = useProjectContextPresence(
    document?.id === designId
      ? {
        designId,
        ...(contextCanSharePageAndSelection && activePageId ? { pageId: activePageId } : {}),
        selectedNodeIds: contextCanSharePageAndSelection ? selectedIds : [],
      }
      : null,
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  const saveWorkspace = () => {
    void saveAllDesignerChanges().catch((cause) => {
      const message = cause instanceof Error ? cause.message : "The workspace could not be saved.";
      useDesignerStore.setState({ saveState: "error", error: message });
      setNotice(`Save failed: ${message}`);
    });
  };

  useEffect(() => {
    if (!archiveReview) return;
    setStageTab("before-after");
  }, [archiveReview?.previewId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = useDesignerStore.getState();
      if (!hasUnsavedDesignerChanges(current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable=true]");
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); saveWorkspace(); return; }
      if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (modifier && event.key.toLowerCase() === "c" && !typing && selectedIds.length > 0) {
        event.preventDefault();
        copiedNodeIds.current = [...selectedIds];
        setNotice(`${selectedIds.length} ${selectedIds.length === 1 ? "layer" : "layers"} copied.`);
        return;
      }
      if (modifier && event.key.toLowerCase() === "v" && !typing && copiedNodeIds.current.length > 0) {
        event.preventDefault();
        useDesignerStore.getState().select(copiedNodeIds.current);
        useDesignerStore.getState().duplicateSelection();
        return;
      }
      if (modifier && event.key.toLowerCase() === "d" && !typing) { event.preventDefault(); duplicate(); return; }
      if (!typing && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); deleteSelection(); return; }
      if (!typing && event.key.toLowerCase() === "v") setTool("select");
      if (!typing && event.key.toLowerCase() === "h") setTool("hand");
      if (!typing && event.key.toLowerCase() === "t") { setTool("text"); addNode("text"); setTool("select"); }
      if (event.key === "Escape") { if (prototypeOpen) closePrototype(); else select([]); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, duplicate, deleteSelection, setTool, addNode, prototypeOpen, closePrototype, select, selectedIds, setNotice]);

  const performExport = async (kind: "json" | "png" | "bundle") => {
    if (!document) return;
    setExporting(kind);
    try {
      const current = useDesignerStore.getState();
      const currentDocument = current.document;
      if (!currentDocument) return;
      if (current.saving
        || current.pendingOperations.length > 0
        || current.archiveReview
        || current.conflictRecovery
        || current.productBriefGuard?.dirty
        || current.saveState !== "saved") {
        window.requestAnimationFrame(() => window.document.querySelector<HTMLButtonElement>(".editor-save-button")?.focus());
        throw new Error("Use Save / Commit before exporting a versioned artifact. Export never silently commits editor changes.");
      }
      if (kind === "json") {
        await downloadFile(exportUrl(currentDocument.id, current.baseVersion), `${currentDocument.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${current.baseVersion}.json`);
      } else if (kind === "bundle") {
        await downloadFile(
          portableExportUrl(currentDocument.id, current.baseVersion),
          `${currentDocument.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${current.baseVersion}.formaspec.zip`,
        );
      } else {
        const selectedFrame = selectedIds.find((id) => currentDocument.nodes[id]?.type === "frame");
        await downloadFile(
          renderUrl(currentDocument.id, { version: current.baseVersion, pageId: activePageId ?? undefined, nodeId: selectedFrame, maxSize: 4096 }),
          `${currentDocument.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${current.baseVersion}.png`,
        );
      }
      setNotice(`${kind.toUpperCase()} export is ready.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(null);
    }
  };

  const loadLatestRecovery = async () => {
    setRecoveryBusy("load");
    try {
      await loadLatestForConflict();
    } finally {
      setRecoveryBusy(null);
    }
  };

  const exportRecoveryPatch = async () => {
    const recovery = useDesignerStore.getState().conflictRecovery;
    if (!recovery) return;
    setRecoveryBusy("export");
    try {
      const artifact = await createConflictPatchArtifact(recovery);
      downloadTextFile(artifact.json, artifact.mediaType, artifact.filename);
      setNotice(`Conflict patch exported · SHA-256 ${artifact.sha256.slice(0, 12)}…`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Conflict patch export failed.");
    } finally {
      setRecoveryBusy(null);
    }
  };

  const duplicateRecoveryDraft = async () => {
    const currentDocument = useDesignerStore.getState().document;
    if (!currentDocument) return;
    setRecoveryBusy("duplicate");
    try {
      const suffix = " — recovered draft";
      await duplicateConflictDraft(`${currentDocument.name.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`);
    } finally {
      setRecoveryBusy(null);
    }
  };

  const discardRecovery = async () => {
    if (!window.confirm("Discard the protected conflict recovery? This cannot be undone. If the conflicting draft is still on the canvas, the latest server revision will be loaded first.")) return;
    setRecoveryBusy("discard");
    try {
      await discardConflictRecovery();
    } finally {
      setRecoveryBusy(null);
    }
  };

  const leaveEditor = () => navigate("/");

  if (loading) return <div className="loading-screen"><div><div className="loading-orbit" />Opening structured canvas…</div></div>;

  if (!document) {
    if (archivedDesignState?.designId === designId) {
      return (
        <div className="loading-screen archived-design-screen">
          <div>
            <Trash2 size={30} />
            <strong>“{archivedDesignState.name}” was deleted</strong>
            <span>{archivedDesignState.hadUnsavedChanges
              ? "The active project was archived elsewhere. Your local canvas and product-brief draft were captured before the editor closed."
              : "The project was archived elsewhere and removed from the active workspace. Immutable server history remains retained for administrators."}</span>
            <div>
              {archivedDesignState.recoveryJson && (
                <button className="button button-secondary" onClick={() => downloadTextFile(
                  archivedDesignState.recoveryJson!,
                  "application/json",
                  `${archivedDesignState.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "formaspec"}-local-recovery.json`,
                )}><Download size={14} /> Download local recovery</button>
              )}
              <button className="button button-primary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="loading-screen">
        <div>
          <CloudOff size={30} style={{ color: "#efb664", marginBottom: 12 }} />
          <strong style={{ display: "block", color: "#e9ebef", marginBottom: 7 }}>The design server is unavailable</strong>
          <span style={{ display: "block", maxWidth: 390, lineHeight: 1.55 }}>{error ?? "Start the self-hosted server, then retry."}</span>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 17 }}>
            <button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
            <button className="button button-primary" onClick={() => void openDesign(designId)}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  const briefDirty = productBriefGuard?.dirty === true;
  const workspaceSaveState = productBriefGuard?.saving
    ? "saving"
    : saveState === "saved" && briefDirty
      ? "dirty"
      : saveState;
  const workspaceSaving = saving || productBriefGuard?.saving === true;
  const saveIcon = workspaceSaveState === "saving"
    ? <LoaderCircle size={12} className="spin" />
    : workspaceSaveState === "review"
      ? <Eye size={12} />
      : workspaceSaveState === "error" || workspaceSaveState === "conflict"
        ? <CloudOff size={12} />
        : workspaceSaveState === "dirty"
          ? <Save size={12} />
          : <Check size={12} />;
  const page = document.pages.find((item) => item.id === prototypePageId);
  const inlinePrototypePageId = prototypePageId
    ?? activePageId
    ?? document.pages.find((item) => !item.archived)?.id
    ?? null;
  const archivedPageId = archiveReview?.operations.find((operation) => operation.type === "archive_page")?.page_id ?? null;
  const comparisonBasePageId = archiveReview
    ? (archivedPageId && archiveReview.baseDocument.pages.some((item) => item.id === archivedPageId)
      ? archivedPageId
      : activePageId && archiveReview.baseDocument.pages.some((item) => item.id === activePageId)
        ? activePageId
        : archiveReview.baseDocument.pages.find((item) => !item.archived)?.id ?? null)
    : null;
  const comparisonPreviewPageId = archiveReview
    ? (comparisonBasePageId && archiveReview.previewDocument.pages.some((item) => item.id === comparisonBasePageId)
      ? comparisonBasePageId
      : archiveReview.previewDocument.pages.find((item) => !item.archived)?.id ?? null)
    : null;

  return (
    <div className={`editor-shell ${conflictRecovery ? "has-conflict-recovery" : ""}`}>
      <header className="editor-topbar">
        <div className="editor-topbar-left">
          <button className="topbar-home" onClick={leaveEditor} aria-label="Back to projects"><Sparkles size={14} /></button>
          <div className="document-title"><strong title={document.name} dir="auto">{document.name}</strong><span className={offline ? "is-offline" : ""}><i /><span>{offline ? "Connection issue" : `Version ${useDesignerStore.getState().baseVersion}`}</span></span></div>
          <button className="icon-button" onClick={() => setSidebarsHidden(!sidebarsHidden)} aria-label="Toggle panels">{sidebarsHidden ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}</button>
        </div>
        <div className="editor-topbar-center">
          <div className="toolbar-segment">
            <button className={`tool-button ${tool === "select" ? "is-active" : ""}`} onClick={() => setTool("select")} title="Select (V)"><MousePointer2 size={13} /></button>
            <button className={`tool-button ${tool === "hand" ? "is-active" : ""}`} onClick={() => setTool("hand")} title="Hand (H)"><Hand size={13} /></button>
            <div className="toolbar-divider" />
            <button className="tool-button" onClick={() => addNode("text")} title="Text (T)"><Type size={13} /></button>
            <div className="frame-menu-wrap">
              <button className="tool-button" onClick={() => setFrameMenu(!frameMenu)} title="Add responsive frame"><LayoutPanelTop size={13} /><ChevronDown size={9} /></button>
              {frameMenu && <div className="frame-menu">
                {(Object.keys(DEVICE_PRESETS) as DevicePreset[]).map((preset) => {
                  const Icon = presetIcons[preset];
                  const item = DEVICE_PRESETS[preset];
                  return <button key={preset} onClick={() => { addFrame(preset); setFrameMenu(false); }}><Icon size={13} /><span><strong>{item.label}</strong><small>{item.width} × {item.height}</small></span></button>;
                })}
              </div>}
            </div>
            <div className="toolbar-divider" />
            <button className="tool-button" disabled={!undoCount} onClick={undo} title="Undo"><Undo2 size={13} /></button>
            <button className="tool-button" disabled={!redoCount} onClick={redo} title="Redo"><Redo2 size={13} /></button>
          </div>
        </div>
        <div className="editor-topbar-right">
          <div className={`save-status is-${workspaceSaveState}`}>{saveIcon}{workspaceSaveState === "saving" ? "Saving" : workspaceSaveState === "dirty" ? "Unsaved" : workspaceSaveState === "review" ? "Review archive" : workspaceSaveState === "error" ? "Retry save" : workspaceSaveState === "conflict" ? "Conflict" : "Saved"}</div>
          <button
            className="button editor-save-button"
            onClick={() => archiveReview ? setStageTab("before-after") : saveWorkspace()}
            disabled={workspaceSaving || (pendingCount === 0 && !briefDirty && !archiveReview) || workspaceSaveState === "conflict"}
            title={archiveReview ? "Review pending destructive changes" : "Save now"}
          ><Save size={13} /><span>{archiveReview ? "Review changes" : "Save / Commit"}</span></button>
          <button className="tool-button" onClick={() => void performExport("json")} disabled={Boolean(exporting) || Boolean(conflictRecovery)} title="Export JSON">{exporting === "json" ? <LoaderCircle size={13} /> : <FileJson size={13} />}</button>
          <button className="tool-button" onClick={() => void performExport("png")} disabled={Boolean(exporting) || Boolean(conflictRecovery)} title="Export PNG">{exporting === "png" ? <LoaderCircle size={13} /> : <ImageDown size={13} />}</button>
          <button className="tool-button" onClick={() => void performExport("bundle")} disabled={Boolean(exporting) || Boolean(conflictRecovery)} title="Export portable FormaSpec bundle">{exporting === "bundle" ? <LoaderCircle size={13} /> : <Download size={13} />}</button>
          <button className="button button-secondary" style={{ minHeight: 30, padding: "0 10px", fontSize: 10 }} onClick={openPrototype}><Play size={12} /> Preview</button>
        </div>
      </header>

      {conflictRecovery && (
        <ConflictRecoveryPanel
          recovery={conflictRecovery}
          durable={conflictRecoveryDurable}
          canLoadLatest={saveState === "conflict" || pendingCount > 0}
          busy={recoveryBusy}
          onLoadLatest={() => void loadLatestRecovery()}
          onExportPatch={() => void exportRecoveryPatch()}
          onDuplicate={() => void duplicateRecoveryDraft()}
          onDiscard={() => void discardRecovery()}
        />
      )}

      <main className={`editor-main ${sidebarsHidden ? "sidebars-hidden" : ""}`}>
        <LayersPanel />
        <section className="editor-stage">
          <nav className="editor-stage-tabs" aria-label="Design workspace">
            {CENTER_WORKSPACE_TABS.map((item) => (
              <button
                key={item}
                className={stageTab === item ? "is-active" : ""}
                aria-pressed={stageTab === item}
                onClick={() => setStageTab(item)}
              >
                {item === "before-after" ? "Before–After" : item[0]!.toUpperCase() + item.slice(1)}
              </button>
            ))}
            <span>{stageTab === "canvas" ? "Editable structured DOM" : stageTab === "prototype" ? "Click-through flow" : "Immutable proposal review"}</span>
          </nav>
          <div className="editor-stage-content">
            {stageTab === "canvas" && <Canvas />}
            {stageTab === "prototype" && inlinePrototypePageId && (
              <div className="editor-inline-prototype">
                <PrototypeCanvas document={document} pageId={inlinePrototypePageId} onNavigate={goToPrototypePage} />
              </div>
            )}
            {stageTab === "prototype" && !inlinePrototypePageId && <div className="editor-stage-empty"><Play size={20} /><strong>No prototype page</strong><small>Add a page and frame to preview the flow.</small></div>}
            {stageTab === "before-after" && archiveReview && comparisonBasePageId && comparisonPreviewPageId && (
              <div className="editor-comparison-workspace">
                <header>
                  <div><strong>Archive comparison</strong><span>Base v{archiveReview.baseVersion} · {archiveReview.changedNodeIds.length} changed layer{archiveReview.changedNodeIds.length === 1 ? "" : "s"}</span></div>
                  <div className="editor-comparison-actions" role="group" aria-label="Archive preview approval actions">
                    <button className="button button-secondary" disabled={saving} onClick={discardArchiveReview}>Discard preview</button>
                    <button className="button button-danger" disabled={saving} onClick={() => void approveArchiveReview()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />} Commit archive</button>
                  </div>
                </header>
                <div className="editor-comparison-grid">
                  <article><header><span>Before</span><strong>Version {archiveReview.baseVersion}</strong></header><div><PrototypeCanvas document={archiveReview.baseDocument} pageId={comparisonBasePageId} onNavigate={() => undefined} /></div></article>
                  <article className="is-proposed"><header><span>After</span><strong>Archive preview</strong></header><div><PrototypeCanvas document={archiveReview.previewDocument} pageId={comparisonPreviewPageId} onNavigate={() => undefined} /></div></article>
                </div>
              </div>
            )}
            {stageTab === "before-after" && (!archiveReview || !comparisonBasePageId || !comparisonPreviewPageId) && (
              <div className="editor-stage-empty"><Eye size={20} /><strong>No archive preview selected</strong><small>Create a destructive archive preview to compare exact before-and-after documents here. Agent proposals remain in the Activity review panel.</small></div>
            )}
          </div>
        </section>
        <InspectorPanel />
      </main>

      <ProductBriefPanel />

      <footer className="editor-statusbar">
        <div><span><MousePointer2 size={9} /> {selectedIds.length ? `${selectedIds.length} selected` : "Ready"}</span><span>Structured DOM canvas</span><span>Schema v{document.schema_version}</span></div>
        <div>
          <span><kbd>⌘S</kbd> Save</span><span><kbd>⌘Z</kbd> Undo</span>
          <button
            type="button"
            className={`project-context-presence is-${projectContextPresence.status}`}
            disabled={projectContextPresence.status === "syncing"}
            onClick={projectContextPresence.retry}
            title={projectContextPresence.error
              ?? (projectContextPresence.status === "standby"
                ? "Another FormaSpec tab owns agent context. Click to make this the active tab."
                : contextCanSharePageAndSelection
                  ? "The current saved project, page, and selection are available to @FormaSpec. Click to refresh."
                  : "The saved project is available to @FormaSpec. Save / Commit to share the current page and selection.")}
            aria-live="polite"
            data-testid="project-context-presence"
          >
            {projectContextPresence.status === "syncing"
              ? <LoaderCircle size={9} className="spin" />
              : projectContextPresence.status === "error"
                ? <CloudOff size={9} />
                : <Eye size={9} />}
            {projectContextPresence.status === "error"
              ? "Agent context failed · Retry"
              : projectContextPresence.status === "standby"
                ? "Another FormaSpec tab is active"
                : projectContextPresence.status === "syncing" || projectContextPresence.status === "idle"
                  ? "Syncing agent context"
                  : contextCanSharePageAndSelection
                    ? "@FormaSpec context synced"
                    : "Project synced · Save to share selection"}
          </button>
        </div>
      </footer>

      {notice && <div className="toast"><Sparkles size={13} />{notice}<button className="icon-button" onClick={() => setNotice(null)}><X size={11} /></button></div>}

      {prototypeOpen && prototypePageId && (
        <div className="prototype-backdrop">
          <header className="prototype-toolbar">
            <div><Play size={14} style={{ color: "#9e94ff" }} /><strong>Prototype preview</strong><span>{page?.name}</span></div>
            <div>
              <select className="prototype-target" style={{ width: 150 }} value={prototypePageId} onChange={(event) => goToPrototypePage(event.target.value as typeof prototypePageId)}>
                {document.pages.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button className="icon-button" onClick={closePrototype} aria-label="Close prototype"><X size={17} /></button>
            </div>
          </header>
          <div className="prototype-stage"><PrototypeCanvas document={document} pageId={prototypePageId} onNavigate={goToPrototypePage} /></div>
        </div>
      )}
    </div>
  );
}
