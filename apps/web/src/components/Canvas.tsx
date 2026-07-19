import {
  Box,
  Circle,
  Expand,
  Image as ImageIcon,
  Minus,
  Plus,
  Scan,
  Sparkles,
  Square,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Moveable from "react-moveable";
import Selecto from "react-selecto";

import {
  isNodeContainer,
  linksForNode,
  nodeChildren,
  parentLayoutMode,
  styleForNode,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type PageId,
} from "../domain";
import { activePage, useDesignerStore } from "../store/designer-store";

const iconGlyphs = {
  sparkles: Sparkles,
  square: Square,
  circle: Circle,
  image: ImageIcon,
  box: Box,
} as const;

interface NodeViewProps {
  document: DesignDocument;
  nodeId: NodeId;
  interactive?: boolean;
  prototype?: boolean;
  onPrototypeNavigate?: (pageId: PageId) => void;
}

export function NodeView({ document, nodeId, interactive = true, prototype = false, onPrototypeNavigate }: NodeViewProps) {
  const node = document.nodes[nodeId];
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const select = useDesignerStore((state) => state.select);
  if (!node || node.archived) return null;

  const children = nodeChildren(node);
  const links = linksForNode(document, nodeId);
  const clickLink = links.find((link) => link.trigger.type === "click");
  const css = styleForNode(document, node);
  const className = [
    prototype ? "prototype-node" : "designer-node",
    `is-${node.type}`,
    selectedIds.includes(node.id) ? "is-selected" : "",
    node.locked ? "is-locked" : "",
    !node.visible ? "is-hidden" : "",
    links.length > 0 && !prototype ? "has-prototype" : "",
  ].filter(Boolean).join(" ");

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (prototype && clickLink) {
      event.stopPropagation();
      if (clickLink.action.type === "navigate" || clickLink.action.type === "open_overlay") {
        onPrototypeNavigate?.(clickLink.action.page_id);
      }
      return;
    }
    if (!interactive || node.locked) return;
    event.stopPropagation();
    select([node.id], event.shiftKey || event.metaKey);
  };

  const content = (() => {
    if (node.type === "text") {
      return <>{node.content}</>;
    }
    if (node.type === "image") {
      return node.asset_id
        ? <img src={`/api/assets/${encodeURIComponent(node.asset_id)}`} alt={node.alt} draggable={false} style={{ width: "100%", height: "100%", objectFit: node.object_fit }} />
        : <ImageIcon size={Math.min(40, node.layout.width / 3)} />;
    }
    if (node.type === "icon") {
      const Icon = iconGlyphs[node.icon_name as keyof typeof iconGlyphs] ?? Sparkles;
      return <Icon size={Math.max(12, Math.min(node.layout.width, node.layout.height) * .46)} aria-label={node.label} />;
    }
    return children.map((childId) => (
      <NodeView
        key={childId}
        document={document}
        nodeId={childId}
        interactive={interactive}
        prototype={prototype}
        onPrototypeNavigate={onPrototypeNavigate}
      />
    ));
  })();

  return (
    <div
      className={className}
      data-node-id={node.id}
      data-node-type={node.type}
      data-action={prototype && Boolean(clickLink)}
      dir={node.type === "text" ? node.direction ?? "auto" : undefined}
      style={{
        ...css,
        ...(node.type === "text" ? { unicodeBidi: "plaintext" } : {}),
      }}
      onClick={handleClick}
    >
      {content}
    </div>
  );
}

export function Canvas() {
  const document = useDesignerStore((state) => state.document);
  const activePageId = useDesignerStore((state) => state.activePageId);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const zoom = useDesignerStore((state) => state.zoom);
  const pan = useDesignerStore((state) => state.pan);
  const tool = useDesignerStore((state) => state.tool);
  const prototypeOpen = useDesignerStore((state) => state.prototypeOpen);
  const select = useDesignerStore((state) => state.select);
  const updateNode = useDesignerStore((state) => state.updateNode);
  const setZoom = useDesignerStore((state) => state.setZoom);
  const setPan = useDesignerStore((state) => state.setPan);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const [panning, setPanning] = useState(false);
  const pointerStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const spacePressed = useRef(false);
  const page = activePage(document, activePageId);
  const canDragSelection = Boolean(document) && selectedIds.every((id) =>
    (parentLayoutMode(document!, id) ?? "absolute") === "absolute");
  const selectedNode = document && selectedIds.length === 1 ? document.nodes[selectedIds[0]!] : undefined;
  const canResizeSelection = canDragSelection
    && selectedIds.length === 1
    && selectedNode?.layout.width_sizing === "fixed"
    && selectedNode.layout.height_sizing === "fixed";

  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.code === "Space" && !event.repeat) spacePressed.current = true; };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") spacePressed.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    setTargets(selectedIds.flatMap((id) => {
      const element = root.querySelector<HTMLElement>(`.designer-node[data-node-id="${CSS.escape(id)}"]`);
      return element ? [element] : [];
    }));
  }, [document, selectedIds, activePageId]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const nextZoom = Math.max(.12, Math.min(3.2, zoom * Math.exp(-event.deltaY * .002)));
      const worldX = (cursorX - pan.x) / zoom;
      const worldY = (cursorY - pan.y) / zoom;
      setZoom(nextZoom);
      setPan({ x: cursorX - worldX * nextZoom, y: cursorY - worldY * nextZoom });
    } else {
      setPan({ x: pan.x - event.deltaX, y: pan.y - event.deltaY });
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const background = event.target === event.currentTarget || (event.target as HTMLElement).classList.contains("canvas-world");
    const shouldPan = tool === "hand" || spacePressed.current || event.button === 1;
    if (shouldPan) {
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      setPanning(true);
      return;
    }
    if (background) select([]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panning) return;
    setPan({
      x: pointerStart.current.panX + event.clientX - pointerStart.current.x,
      y: pointerStart.current.panY + event.clientY - pointerStart.current.y,
    });
  };

  const stopPanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panning && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPanning(false);
  };

  const fitCanvas = useCallback(() => {
    if (!document || !page || !viewportRef.current || page.children.length === 0) return;
    const frames = page.children.map((id) => document.nodes[id]).filter(Boolean) as DesignNode[];
    const left = Math.min(...frames.map((node) => node.layout.x));
    const top = Math.min(...frames.map((node) => node.layout.y));
    const right = Math.max(...frames.map((node) => node.layout.x + node.layout.width));
    const bottom = Math.max(...frames.map((node) => node.layout.y + node.layout.height));
    const rect = viewportRef.current.getBoundingClientRect();
    const nextZoom = Math.max(.12, Math.min(1.15, Math.min((rect.width - 140) / (right - left), (rect.height - 140) / (bottom - top))));
    setZoom(nextZoom);
    setPan({
      x: (rect.width - (right - left) * nextZoom) / 2 - left * nextZoom,
      y: (rect.height - (bottom - top) * nextZoom) / 2 - top * nextZoom,
    });
  }, [document, page, setPan, setZoom]);

  useEffect(() => {
    if (document && page) requestAnimationFrame(fitCanvas);
  }, [document?.id, page?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitDrag = (target: HTMLElement, delta: readonly number[]) => {
    const nodeId = target.dataset.nodeId as NodeId | undefined;
    const node = nodeId ? document?.nodes[nodeId] : undefined;
    target.style.transform = "";
    if (!node || (!delta[0] && !delta[1])) return;
    updateNode(node.id, { layout: { x: Math.round(node.layout.x + delta[0]!), y: Math.round(node.layout.y + delta[1]!) } });
  };

  const frameLabels = useMemo(() => {
    if (!document || !page) return [];
    return page.children.flatMap((id) => {
      const node = document.nodes[id];
      if (!node || node.archived) return [];
      return [{ id, name: node.name, width: node.layout.width, height: node.layout.height, x: node.layout.x, y: node.layout.y }];
    });
  }, [document, page]);

  return (
    <section
      ref={viewportRef}
      className={`canvas-viewport ${panning ? "is-panning" : ""}`}
      data-tool={tool}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPanning}
      onPointerCancel={stopPanning}
    >
      {document && page ? (
        <div className="canvas-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {frameLabels.map((frame) => (
            <div key={`label-${frame.id}`} className="canvas-frame-label" style={{ left: frame.x, top: frame.y - 24 }}>
              {frame.name} <span>{Math.round(frame.width)} × {Math.round(frame.height)}</span>
            </div>
          ))}
          {page.children.map((nodeId) => <NodeView key={nodeId} document={document} nodeId={nodeId} />)}
        </div>
      ) : (
        <div className="canvas-empty"><div><span><Scan size={23} /></span><strong>No frame on this page</strong><small>Add a responsive frame to begin designing.</small></div></div>
      )}

      {document && viewportRef.current && tool === "select" && !prototypeOpen && (
        <Selecto
          container={viewportRef.current}
          dragContainer={viewportRef.current}
          selectableTargets={[".designer-node:not(.is-locked)"]}
          selectByClick
          selectFromInside={false}
          continueSelect={false}
          toggleContinueSelect={["shift"]}
          hitRate={12}
          onSelectEnd={(event) => {
            const ids = event.selected.flatMap((element) => {
              const id = (element as HTMLElement).dataset.nodeId as NodeId | undefined;
              return id ? [id] : [];
            });
            select(ids, event.inputEvent.shiftKey || event.inputEvent.metaKey);
          }}
        />
      )}

      {document && targets.length > 0 && tool === "select" && !prototypeOpen && (
        <Moveable
          target={targets}
          container={viewportRef.current}
          origin={false}
          draggable={canDragSelection}
          resizable={canResizeSelection}
          snappable
          snapThreshold={6}
          elementGuidelines={viewportRef.current ? [...viewportRef.current.querySelectorAll<HTMLElement>(".designer-node")].filter((item) => !targets.includes(item)) : []}
          bounds={undefined}
          throttleDrag={1}
          throttleResize={1}
          onDrag={(event) => { event.target.style.transform = event.transform; }}
          onDragEnd={(event) => commitDrag(event.target as HTMLElement, event.lastEvent?.beforeTranslate ?? [0, 0])}
          onDragGroup={(event) => event.events.forEach((item) => { (item.target as HTMLElement).style.transform = item.transform; })}
          onDragGroupEnd={(event) => event.events.forEach((item) => commitDrag(item.target as HTMLElement, item.lastEvent?.beforeTranslate ?? [0, 0]))}
          onResize={(event) => {
            event.target.style.width = `${event.width}px`;
            event.target.style.height = `${event.height}px`;
            event.target.style.transform = event.drag.transform;
          }}
          onResizeEnd={(event) => {
            const target = event.target as HTMLElement;
            const nodeId = target.dataset.nodeId as NodeId | undefined;
            const node = nodeId ? document.nodes[nodeId] : undefined;
            const last = event.lastEvent;
            target.style.transform = "";
            if (!node || !last) return;
            updateNode(node.id, {
              layout: {
                x: Math.round(node.layout.x + last.drag.beforeTranslate[0]),
                y: Math.round(node.layout.y + last.drag.beforeTranslate[1]),
                width: Math.max(1, Math.round(last.width)),
                height: Math.max(1, Math.round(last.height)),
              },
            });
          }}
        />
      )}

      <div className="canvas-floatbar">
        <button onClick={() => setZoom(zoom / 1.18)} aria-label="Zoom out"><Minus size={14} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(zoom * 1.18)} aria-label="Zoom in"><Plus size={14} /></button>
        <div className="toolbar-divider" />
        <button onClick={fitCanvas} aria-label="Fit canvas"><Expand size={14} /></button>
      </div>
    </section>
  );
}

export function PrototypeCanvas({ document, pageId, onNavigate }: { document: DesignDocument; pageId: PageId; onNavigate: (pageId: PageId) => void }) {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const rootId = page?.children.find((id) => !document.nodes[id]?.archived);
  const root = rootId ? document.nodes[rootId] : undefined;
  if (!page || !rootId || !root) return <div className="canvas-empty"><div><strong>This page is empty</strong></div></div>;
  return (
    <div
      className="prototype-frame"
      style={{ width: root.layout.width, height: root.layout.height, background: typeof page.background === "string" ? page.background : "#fff" } as CSSProperties}
    >
      <NodeView document={document} nodeId={rootId} interactive={false} prototype onPrototypeNavigate={onNavigate} />
    </div>
  );
}
