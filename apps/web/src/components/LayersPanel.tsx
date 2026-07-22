import {
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  File,
  Image,
  Layers3,
  Lock,
  LockOpen,
  LoaderCircle,
  Minus,
  MoveDown,
  MoveUp,
  MousePointerClick,
  PanelsTopLeft,
  Plus,
  Sparkles,
  Square,
  ShieldAlert,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  isNodeContainer,
  nodeChildren,
  pageIdForNode,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type NodeType,
  type PageId,
} from "../domain";
import { LEFT_PANEL_TABS, type LeftPanelTab } from "../lib/editor-information-architecture";
import { activePage, useDesignerStore } from "../store/designer-store";
import { ComponentLibraryPanel } from "./ComponentLibraryPanel";

function TypeIcon({ node }: { node: DesignNode }) {
  const props = { size: 12, strokeWidth: 1.7 };
  if (node.type === "text") return <Type {...props} />;
  if (node.type === "ellipse") return <Circle {...props} />;
  if (node.type === "image") return <Image {...props} />;
  if (node.type === "icon") return <Sparkles {...props} />;
  if (node.type === "frame") return <Layers3 {...props} />;
  if (node.type === "group" || node.type === "component") return <Box {...props} />;
  return <Square {...props} />;
}

const addItems: Array<{ type: NodeType; label: string; icon: typeof Square }> = [
  { type: "group", label: "Stack", icon: Box },
  { type: "text", label: "Text", icon: Type },
  { type: "rectangle", label: "Rectangle", icon: Square },
  { type: "ellipse", label: "Ellipse", icon: Circle },
  { type: "image", label: "Image", icon: Image },
  { type: "icon", label: "Icon", icon: Sparkles },
];

export function selectNodeAcrossPages(
  document: DesignDocument,
  nodeId: NodeId,
  setActivePage: (pageId: PageId) => void,
  select: (nodeIds: NodeId[]) => void,
): boolean {
  const pageId = pageIdForNode(document, nodeId);
  if (!pageId) return false;
  setActivePage(pageId);
  select([nodeId]);
  return true;
}

export function PageDeleteDialog({
  pageName,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  pageName: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    window.requestAnimationFrame(() => dialogRef.current?.focus());
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? index <= 0 ? buttons.length - 1 : index - 1
      : index < 0 || index === buttons.length - 1 ? 0 : index + 1;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };
  return (
    <section
      className="page-delete-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="page-delete-title"
      aria-describedby="page-delete-description"
      tabIndex={-1}
      ref={dialogRef}
      onKeyDown={onKeyDown}
    >
      <header>
        <span><ShieldAlert size={18} /></span>
        <div><h2 id="page-delete-title">Delete page?</h2><p id="page-delete-description">“{pageName}” and its layers will be soft-deleted only after you review the exact before-and-after preview.</p></div>
        <button className="icon-button" disabled={busy} onClick={onCancel} aria-label="Close page deletion confirmation"><X size={15} /></button>
      </header>
      <div className="page-delete-retention"><ShieldAlert size={14} /><span>Immutable history remains recoverable. FormaSpec will not commit the archive from this dialog.</span></div>
      {error && <div className="page-delete-error" role="alert">{error}</div>}
      <footer>
        <button className="button button-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="button button-danger" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />} Create deletion preview</button>
      </footer>
    </section>
  );
}

function LayerRow({ nodeId, depth, collapsed, toggleCollapsed }: {
  nodeId: NodeId;
  depth: number;
  collapsed: Set<NodeId>;
  toggleCollapsed: (id: NodeId) => void;
}) {
  const document = useDesignerStore((state) => state.document);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const select = useDesignerStore((state) => state.select);
  const updateNode = useDesignerStore((state) => state.updateNode);
  const moveSelection = useDesignerStore((state) => state.moveSelection);
  const node = document?.nodes[nodeId];
  if (!document || !node || node.archived) return null;
  const children = nodeChildren(node);
  const isSelected = selectedIds.includes(node.id);
  const isCollapsed = collapsed.has(node.id);

  return (
    <>
      <div
        className={`layer-row ${isSelected ? "is-selected" : ""}`}
        data-layer-node-id={node.id}
        style={{ paddingLeft: 4 + depth * 13 }}
        onClick={(event) => select([node.id], event.shiftKey || event.metaKey)}
      >
        {isNodeContainer(node) && children.length > 0 ? (
          <button className="layer-toggle" onClick={(event) => { event.stopPropagation(); toggleCollapsed(node.id); }} aria-label={isCollapsed ? "Expand layer" : "Collapse layer"}>
            {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          </button>
        ) : <span className="layer-toggle" />}
        <span className="layer-icon"><TypeIcon node={node} /></span>
        <span className="layer-name">{node.name}</span>
        <span className="layer-actions">
          {isSelected && <>
            <button onClick={(event) => { event.stopPropagation(); moveSelection(-1); }} aria-label="Move layer up"><MoveUp size={10} /></button>
            <button onClick={(event) => { event.stopPropagation(); moveSelection(1); }} aria-label="Move layer down"><MoveDown size={10} /></button>
          </>}
          <button onClick={(event) => { event.stopPropagation(); updateNode(node.id, { visible: !node.visible }); }} aria-label={node.visible ? "Hide layer" : "Show layer"}>{node.visible ? <Eye size={10} /> : <EyeOff size={10} />}</button>
          <button onClick={(event) => { event.stopPropagation(); updateNode(node.id, { locked: !node.locked }); }} aria-label={node.locked ? "Unlock layer" : "Lock layer"}>{node.locked ? <Lock size={10} /> : <LockOpen size={10} />}</button>
        </span>
      </div>
      {!isCollapsed && children.map((childId) => (
        <LayerRow key={childId} nodeId={childId} depth={depth + 1} collapsed={collapsed} toggleCollapsed={toggleCollapsed} />
      ))}
    </>
  );
}

export function LayersPanel() {
  const document = useDesignerStore((state) => state.document);
  const activePageId = useDesignerStore((state) => state.activePageId);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const setActivePage = useDesignerStore((state) => state.setActivePage);
  const select = useDesignerStore((state) => state.select);
  const addPage = useDesignerStore((state) => state.addPage);
  const deletePage = useDesignerStore((state) => state.deletePage);
  const save = useDesignerStore((state) => state.save);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const addNode = useDesignerStore((state) => state.addNode);
  const insertTemplate = useDesignerStore((state) => state.insertTemplate);
  const [tab, setTab] = useState<LeftPanelTab>("layers");
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  const [deleteTargetId, setDeleteTargetId] = useState<PageId | null>(null);
  const [deletingPage, setDeletingPage] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const page = activePage(document, activePageId);
  const pages = useMemo(() => document?.pages.filter((candidate) => !candidate.archived) ?? [], [document]);
  const components = useMemo(() => Object.values(document?.nodes ?? {})
    .filter((node) => !node.archived && (node.type === "component" || node.type === "instance")), [document]);
  const assets = useMemo(() => Object.values(document?.assets ?? {}), [document]);
  const deleteTarget = document?.pages.find((candidate) => candidate.id === deleteTargetId) ?? null;

  const requestPageDelete = (pageId: PageId) => {
    const current = useDesignerStore.getState();
    if (current.pendingOperations.length > 0
      || current.saving
      || current.archiveReview
      || current.conflictRecovery
      || current.saveState !== "saved") {
      setNotice("Use Save / Commit for current canvas edits before deleting a page.");
      window.requestAnimationFrame(() => window.document.querySelector<HTMLButtonElement>(".editor-save-button")?.focus());
      return;
    }
    setDeleteTargetId(pageId);
    setDeleteError(null);
  };

  const confirmPageDelete = async () => {
    if (!deleteTarget || deletingPage) return;
    setDeletingPage(true);
    setDeleteError(null);
    deletePage(deleteTarget.id);
    try {
      await save();
      const current = useDesignerStore.getState();
      if (!current.archiveReview) {
        throw new Error(current.error ?? "The page deletion preview could not be created.");
      }
      setDeleteTargetId(null);
      setNotice(`Deletion preview for “${deleteTarget.name}” is ready. Compare it, then Commit archive or Discard preview.`);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "The page deletion preview could not be created.");
    } finally {
      setDeletingPage(false);
    }
  };

  const selectAssetUsage = (assetId: string) => {
    if (!document) return;
    const usage = Object.values(document.nodes).find((node) =>
      !node.archived && node.type === "image" && node.asset_id === assetId);
    if (usage) selectNodeAcrossPages(document, usage.id, setActivePage, select);
  };

  return (
    <aside className="left-sidebar">
      <nav className="sidebar-tabs sidebar-tabs-compact" aria-label="Project structure">
        {LEFT_PANEL_TABS.map((item) => (
          <button
            key={item}
            className={`sidebar-tab ${tab === item ? "is-active" : ""}`}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >{item}</button>
        ))}
      </nav>

      {tab === "pages" && (
        <div className="sidebar-pane">
          <div className="sidebar-section-heading"><span>Pages</span><button onClick={addPage} aria-label="Add page"><Plus size={12} /></button></div>
          <div className="pages-list pages-list-detailed">
            {pages.map((item) => {
              const activeChildren = item.children.filter((id) => !document?.nodes[id]?.archived);
              return (
                <div className="page-row-shell" key={item.id} data-page-id={item.id}>
                  <button className={`page-row page-row-detailed ${item.id === page?.id ? "is-active" : ""}`} title={item.name} onClick={() => setActivePage(item.id)}>
                    <File size={12} />
                    <span><strong dir="auto">{item.name}</strong><small>{activeChildren.length} root {activeChildren.length === 1 ? "frame" : "frames"}</small></span>
                    {item.id === page?.id && <Minus size={9} />}
                  </button>
                  <button
                    className="page-row-delete"
                    disabled={pages.length <= 1}
                    aria-label={`Delete page ${item.name}`}
                    title={pages.length <= 1 ? "A design must keep at least one page" : `Delete ${item.name}`}
                    onClick={() => requestPageDelete(item.id)}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === "layers" && (
        <div className="sidebar-pane">
          <div className="add-menu">
            {addItems.map((item) => {
              const Icon = item.icon;
              return <button key={item.type} onClick={() => addNode(item.type)}><Icon size={12} />{item.label}</button>;
            })}
            <button onClick={() => insertTemplate("button")}><MousePointerClick size={12} />Button</button>
            <button onClick={() => insertTemplate("card")}><PanelsTopLeft size={12} />Card</button>
          </div>
          <div className="sidebar-section-heading sidebar-section-heading-titled">
            <span dir="auto" title={page?.name ?? "Layers"}>{page?.name ?? "Layers"}</span>
            <span aria-label={`${page?.children.length ?? 0} root layers`}>{page?.children.length ?? 0}</span>
          </div>
          <div className="layers-scroll">
            {page?.children.map((nodeId) => (
              <LayerRow
                key={nodeId}
                nodeId={nodeId}
                depth={0}
                collapsed={collapsed}
                toggleCollapsed={(id) => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "components" && (
        <div className="sidebar-pane component-sidebar-pane">
          <div className="sidebar-pane-intro"><PanelsTopLeft size={14} /><div><strong>Components</strong><small>Insert exact pinned-release components, then inspect project-local sources and instances.</small></div></div>
          <ComponentLibraryPanel />
          <div className="sidebar-section-heading"><span>Project sources</span><span>{components.length}</span></div>
          <div className="entity-list component-project-entities">
            {components.map((node) => (
              <button key={node.id} onClick={() => document && selectNodeAcrossPages(document, node.id, setActivePage, select)} className={selectedIds.includes(node.id) ? "is-active" : ""}>
                <TypeIcon node={node} />
                <span><strong>{node.name}</strong><small>{node.type === "component" ? node.component_key : node.type === "instance" ? `Instance · ${node.component_id.slice(-8)}` : node.type}</small></span>
              </button>
            ))}
            {components.length === 0 && <div className="sidebar-empty"><Box size={17} /><strong>No linked components</strong><small>Templates remain detached in V1. V2 migration creates project-local definitions.</small></div>}
          </div>
        </div>
      )}

      {tab === "assets" && (
        <div className="sidebar-pane">
          <div className="sidebar-pane-intro"><Image size={14} /><div><strong>Assets</strong><small>Normalized, content-addressed project files.</small></div></div>
          <div className="entity-list">
            {assets.map((asset) => {
              const usages = document ? Object.values(document.nodes).filter((node) =>
                !node.archived && node.type === "image" && node.asset_id === asset.id).length : 0;
              return (
                <button key={asset.id} onClick={() => selectAssetUsage(asset.id)} disabled={usages === 0}>
                  <Image size={12} />
                  <span><strong>{asset.name}</strong><small>{asset.mime_type} · {usages} {usages === 1 ? "use" : "uses"}</small></span>
                </button>
              );
            })}
            {assets.length === 0 && <div className="sidebar-empty"><Image size={17} /><strong>No uploaded assets</strong><small>Add an image layer, then upload PNG, JPEG, or WebP from Content.</small><button onClick={() => addNode("image")}><Plus size={11} /> Add image layer</button></div>}
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="modal-backdrop page-delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (!deletingPage && event.currentTarget === event.target) setDeleteTargetId(null);
        }}>
          <PageDeleteDialog
            pageName={deleteTarget.name}
            busy={deletingPage}
            error={deleteError}
            onCancel={() => { if (!deletingPage) setDeleteTargetId(null); }}
            onConfirm={() => void confirmPageDelete()}
          />
        </div>
      )}
    </aside>
  );
}
