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
import { exportUrl, renderUrl, updateContext } from "../lib/api";
import { useDesignerStore } from "../store/designer-store";
import { Canvas, PrototypeCanvas } from "./Canvas";
import { InspectorPanel } from "./InspectorPanel";
import { LayersPanel } from "./LayersPanel";

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
  const openDesign = useDesignerStore((state) => state.openDesign);
  const closeDesign = useDesignerStore((state) => state.closeDesign);
  const connectEvents = useDesignerStore((state) => state.connectEvents);
  const save = useDesignerStore((state) => state.save);
  const undo = useDesignerStore((state) => state.undo);
  const redo = useDesignerStore((state) => state.redo);
  const reloadConflict = useDesignerStore((state) => state.reloadConflict);
  const setTool = useDesignerStore((state) => state.setTool);
  const select = useDesignerStore((state) => state.select);
  const addNode = useDesignerStore((state) => state.addNode);
  const addFrame = useDesignerStore((state) => state.addFrame);
  const duplicate = useDesignerStore((state) => state.duplicateSelection);
  const deleteSelection = useDesignerStore((state) => state.deleteSelection);
  const openPrototype = useDesignerStore((state) => state.openPrototype);
  const closePrototype = useDesignerStore((state) => state.closePrototype);
  const goToPrototypePage = useDesignerStore((state) => state.goToPrototypePage);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const setSidebarsHidden = useDesignerStore((state) => state.setSidebarsHidden);
  const [frameMenu, setFrameMenu] = useState(false);
  const [exporting, setExporting] = useState<"json" | "png" | null>(null);
  const copiedNodeIds = useRef<typeof selectedIds>([]);

  useEffect(() => {
    void openDesign(designId);
    const disconnect = connectEvents();
    return () => {
      disconnect();
      void updateContext({ designId: null, selectedNodeIds: [] }).catch(() => undefined);
      closeDesign();
    };
  }, [designId, openDesign, connectEvents, closeDesign]);

  useEffect(() => {
    const publishContext = () => {
      if (window.document.visibilityState !== "visible") return;
      const current = useDesignerStore.getState();
      if (!current.document || current.document.id !== designId) return;
      void updateContext({
        designId,
        ...(current.activePageId ? { pageId: current.activePageId } : {}),
        selectedNodeIds: current.selectedIds,
      }).catch(() => undefined);
    };
    const timer = window.setInterval(publishContext, 60_000);
    window.addEventListener("focus", publishContext);
    window.document.addEventListener("visibilitychange", publishContext);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", publishContext);
      window.document.removeEventListener("visibilitychange", publishContext);
    };
  }, [designId]);

  useEffect(() => {
    if (pendingCount === 0 || saving || saveState === "error" || saveState === "conflict") return;
    const timer = window.setTimeout(() => void save(), 950);
    return () => window.clearTimeout(timer);
  }, [pendingCount, saving, save, saveState]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = useDesignerStore.getState();
      if (!current.saving
        && current.pendingOperations.length === 0
        && (current.saveState === "saved" || current.saveState === "idle")) return;
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
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
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
  }, [save, undo, redo, duplicate, deleteSelection, setTool, addNode, prototypeOpen, closePrototype, select, selectedIds, setNotice]);

  const performExport = async (kind: "json" | "png") => {
    if (!document) return;
    setExporting(kind);
    try {
      if (pendingCount > 0 || saving) await save();
      const current = useDesignerStore.getState();
      const currentDocument = current.document;
      if (!currentDocument) return;
      if (current.saving || current.pendingOperations.length > 0 || current.saveState !== "saved") {
        throw new Error("Save the current edits before exporting a versioned artifact.");
      }
      if (kind === "json") {
        await downloadFile(exportUrl(currentDocument.id, current.baseVersion), `${currentDocument.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${current.baseVersion}.json`);
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

  const leaveEditor = async () => {
    const initial = useDesignerStore.getState();
    if (initial.saving || initial.pendingOperations.length > 0) await initial.save();
    const latest = useDesignerStore.getState();
    const unresolved = latest.saving
      || latest.pendingOperations.length > 0
      || latest.saveState === "dirty"
      || latest.saveState === "error"
      || latest.saveState === "conflict";
    if (unresolved && !window.confirm("These edits are not saved. Leave the designer and discard the local draft?")) return;
    navigate("/");
  };

  if (loading) return <div className="loading-screen"><div><div className="loading-orbit" />Opening structured canvas…</div></div>;

  if (!document) {
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

  const saveIcon = saveState === "saving" ? <LoaderCircle size={12} className="spin" /> : saveState === "error" || saveState === "conflict" ? <CloudOff size={12} /> : <Check size={12} />;
  const page = document.pages.find((item) => item.id === prototypePageId);

  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-topbar-left">
          <button className="topbar-home" onClick={() => void leaveEditor()} aria-label="Back to projects"><Sparkles size={14} /></button>
          <div className="document-title"><strong>{document.name}</strong><span className={offline ? "is-offline" : ""}><i />{offline ? "Connection issue" : `Version ${useDesignerStore.getState().baseVersion}`}</span></div>
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
          <div className={`save-status is-${saveState}`}>{saveIcon}{saveState === "saving" ? "Saving" : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Retry save" : saveState === "conflict" ? "Conflict" : "Saved"}</div>
          {saveState === "conflict" && <button className="button button-secondary" style={{ minHeight: 30, padding: "0 9px", fontSize: 9 }} onClick={() => {
            if (window.confirm("Load the latest server revision and discard this conflicting local draft?")) void reloadConflict();
          }}>Reload latest</button>}
          <button className="tool-button" onClick={() => void save()} disabled={saving || pendingCount === 0 || saveState === "conflict"} title="Save now"><Save size={13} /></button>
          <button className="tool-button" onClick={() => void performExport("json")} disabled={Boolean(exporting) || saveState === "conflict"} title="Export JSON">{exporting === "json" ? <LoaderCircle size={13} /> : <FileJson size={13} />}</button>
          <button className="tool-button" onClick={() => void performExport("png")} disabled={Boolean(exporting) || saveState === "conflict"} title="Export PNG">{exporting === "png" ? <LoaderCircle size={13} /> : <ImageDown size={13} />}</button>
          <button className="button button-secondary" style={{ minHeight: 30, padding: "0 10px", fontSize: 10 }} onClick={openPrototype}><Play size={12} /> Preview</button>
        </div>
      </header>

      <main className={`editor-main ${sidebarsHidden ? "sidebars-hidden" : ""}`}>
        <LayersPanel />
        <Canvas />
        <InspectorPanel />
      </main>

      <footer className="editor-statusbar">
        <div><span><MousePointer2 size={9} /> {selectedIds.length ? `${selectedIds.length} selected` : "Ready"}</span><span>Structured DOM canvas</span><span>Schema v{document.schema_version}</span></div>
        <div><span><kbd>⌘S</kbd> Save</span><span><kbd>⌘Z</kbd> Undo</span><span><Eye size={9} /> Codex context synced</span></div>
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
