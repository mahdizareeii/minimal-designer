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
  Minus,
  MoveDown,
  MoveUp,
  MousePointerClick,
  PanelsTopLeft,
  Plus,
  Sparkles,
  Square,
  Type,
} from "lucide-react";
import { useMemo, useState } from "react";

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
  const addNode = useDesignerStore((state) => state.addNode);
  const insertTemplate = useDesignerStore((state) => state.insertTemplate);
  const [tab, setTab] = useState<LeftPanelTab>("layers");
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  const page = activePage(document, activePageId);
  const pages = useMemo(() => document?.pages.filter((candidate) => !candidate.archived) ?? [], [document]);
  const components = useMemo(() => Object.values(document?.nodes ?? {})
    .filter((node) => !node.archived && (node.type === "component" || node.type === "instance")), [document]);
  const assets = useMemo(() => Object.values(document?.assets ?? {}), [document]);

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
                <button className={`page-row page-row-detailed ${item.id === page?.id ? "is-active" : ""}`} key={item.id} onClick={() => setActivePage(item.id)}>
                  <File size={12} />
                  <span><strong>{item.name}</strong><small>{activeChildren.length} root {activeChildren.length === 1 ? "frame" : "frames"}</small></span>
                  {item.id === page?.id && <Minus size={9} />}
                </button>
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
          <div className="sidebar-section-heading"><span>{page?.name ?? "Layers"}</span><span>{page?.children.length ?? 0}</span></div>
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
        <div className="sidebar-pane">
          <div className="sidebar-pane-intro"><PanelsTopLeft size={14} /><div><strong>Components</strong><small>Project-local definitions and pinned instances.</small></div></div>
          <div className="entity-list">
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
    </aside>
  );
}
