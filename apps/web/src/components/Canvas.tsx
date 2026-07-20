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
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Moveable from "react-moveable";
import Selecto from "react-selecto";

import {
  linksForNode,
  nodeChildren,
  parentOf,
  styleForNode,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type PageId,
} from "../domain";
import {
  autoLayoutDropContainers,
  autoLayoutInsertionIndex,
  canonicalizeNodeSelection,
  chooseAutoLayoutDropContainer,
  composeDraftTransform,
  normalizeGeometryNumber,
  resizePatchForGesture,
  selectionGestureCapabilities,
  sameNodeSelection,
} from "../lib/canvas-geometry";
import { clientPointInViewport, ViewportTransform } from "../lib/viewport-transform";
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
  parentMode?: DesignNode["layout"]["mode"] | null;
  interactive?: boolean;
  prototype?: boolean;
  highlightedIds?: ReadonlySet<NodeId>;
  reviewTone?: "before" | "after";
  onPrototypeNavigate?: (pageId: PageId) => void;
}

function NodeViewComponent({
  document,
  nodeId,
  parentMode = null,
  interactive = true,
  prototype = false,
  highlightedIds,
  reviewTone,
  onPrototypeNavigate,
}: NodeViewProps) {
  const selected = useDesignerStore((state) => interactive && state.selectedIds.includes(nodeId));
  const select = useDesignerStore((state) => state.select);
  const node = document.nodes[nodeId];
  if (!node || node.archived) return null;

  const children = nodeChildren(node);
  const links = linksForNode(document, nodeId);
  const clickLink = links.find((link) => link.trigger.type === "click");
  const css = styleForNode(document, node, { parentLayoutMode: parentMode });
  const className = [
    prototype ? "prototype-node" : "designer-node",
    `is-${node.type}`,
    selected ? "is-selected" : "",
    node.locked ? "is-locked" : "",
    !node.visible ? "is-hidden" : "",
    links.length > 0 && !prototype ? "has-prototype" : "",
    reviewTone ? "is-review-node" : "",
    reviewTone ? `is-review-${reviewTone}` : "",
    highlightedIds?.has(node.id) ? "is-review-changed" : "",
  ].filter(Boolean).join(" ");

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (prototype && clickLink) {
      event.stopPropagation();
      if (clickLink.action.type === "navigate" || clickLink.action.type === "open_overlay") {
        onPrototypeNavigate?.(clickLink.action.page_id);
      }
      return;
    }
    if (!interactive || node.locked || !node.visible) return;
    event.stopPropagation();
    select([node.id], event.shiftKey || event.metaKey);
  };

  const content = (() => {
    if (node.type === "text") return <>{node.content}</>;
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
        parentMode={node.layout.mode}
        interactive={interactive}
        prototype={prototype}
        highlightedIds={highlightedIds}
        reviewTone={reviewTone}
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

export const NodeView = memo(NodeViewComponent);
NodeView.displayName = "NodeView";

function nodeForTarget(document: DesignDocument | null, target: HTMLElement): DesignNode | undefined {
  const nodeId = target.dataset.nodeId as NodeId | undefined;
  return nodeId ? document?.nodes[nodeId] : undefined;
}

function setDraftTranslation(target: HTMLElement, node: DesignNode, translation: readonly [number, number]): void {
  target.style.transform = composeDraftTransform(node.layout.rotation, translation);
}

function restoreCanonicalGeometry(target: HTMLElement, node: DesignNode, restoreSize = false): void {
  target.style.transform = composeDraftTransform(node.layout.rotation);
  if (restoreSize) {
    target.style.width = node.layout.width_sizing === "fill"
      ? "100%"
      : node.layout.width_sizing === "hug" ? "fit-content" : `${node.layout.width}px`;
    target.style.height = node.layout.height_sizing === "fill"
      ? "100%"
      : node.layout.height_sizing === "hug" ? "fit-content" : `${node.layout.height}px`;
  }
}

function parentLayoutModeForNode(document: DesignDocument, nodeId: NodeId): DesignNode["layout"]["mode"] | undefined {
  const parent = parentOf(document, nodeId);
  return parent && "node_id" in parent ? document.nodes[parent.node_id]?.layout.mode : undefined;
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
  const updateNodes = useDesignerStore((state) => state.updateNodes);
  const moveNodeByGesture = useDesignerStore((state) => state.moveNodeByGesture);
  const setZoom = useDesignerStore((state) => state.setZoom);
  const setPan = useDesignerStore((state) => state.setPan);
  const setViewport = useDesignerStore((state) => state.setViewport);

  const [editorRoot, setEditorRoot] = useState<HTMLElement | null>(null);
  const [canvasLayer, setCanvasLayer] = useState<HTMLDivElement | null>(null);
  const [interactionOverlay, setInteractionOverlay] = useState<HTMLDivElement | null>(null);
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const [panning, setPanning] = useState(false);
  const moveableRef = useRef<Moveable>(null);
  const geometryFrame = useRef<number | null>(null);
  const pointerStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const spacePressed = useRef(false);

  const page = activePage(document, activePageId);
  const viewportTransform = useMemo(() => new ViewportTransform({ pan, zoom }), [pan, zoom]);
  const canonicalSelectedIds = useMemo(
    () => document ? canonicalizeNodeSelection(document, selectedIds, page?.id ?? activePageId) : [],
    [activePageId, document, page?.id, selectedIds],
  );
  const gestureCapabilities = useMemo(
    () => document
      ? selectionGestureCapabilities(document, canonicalSelectedIds)
      : { draggable: false, resizable: false, flow: "none" as const },
    [canonicalSelectedIds, document],
  );
  const canDragSelection = gestureCapabilities.draggable;
  const canResizeSelection = gestureCapabilities.resizable;

  const scheduleGeometryRefresh = useCallback(() => {
    if (geometryFrame.current !== null) return;
    geometryFrame.current = requestAnimationFrame(() => {
      geometryFrame.current = null;
      moveableRef.current?.updateRect();
    });
  }, []);

  useEffect(() => () => {
    if (geometryFrame.current !== null) cancelAnimationFrame(geometryFrame.current);
  }, []);

  useEffect(() => {
    if (!document || !page || !editorRoot || !canvasLayer) return;
    let cancelled = false;
    const revision = document.revision;
    const markInteractive = async () => {
      await globalThis.document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (cancelled || !editorRoot.isConnected || !canvasLayer.isConnected) return;
      const renderedNodeCount = canvasLayer.querySelectorAll(".designer-node[data-node-id]").length;
      editorRoot.dataset.formaspecEditorReady = "true";
      editorRoot.dataset.formaspecReadyRevision = String(revision);
      editorRoot.dataset.formaspecRenderedNodeCount = String(renderedNodeCount);
      performance.clearMarks("formaspec:editor-interactive");
      performance.mark("formaspec:editor-interactive", {
        detail: {
          designId: document.id,
          pageId: page.id,
          revision,
          renderedNodeCount,
        },
      });
    };
    void markInteractive();
    return () => { cancelled = true; };
  }, [canvasLayer, document, editorRoot, page]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat) spacePressed.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") spacePressed.current = false;
    };
    const blur = () => { spacePressed.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (document && !sameNodeSelection(selectedIds, canonicalSelectedIds)) select(canonicalSelectedIds);
  }, [canonicalSelectedIds, document, select, selectedIds]);

  useLayoutEffect(() => {
    if (!canvasLayer) {
      setTargets([]);
      return;
    }
    const elementsById = new Map<NodeId, HTMLElement>();
    for (const element of canvasLayer.querySelectorAll<HTMLElement>(".designer-node[data-node-id]")) {
      const nodeId = element.dataset.nodeId as NodeId | undefined;
      if (nodeId) elementsById.set(nodeId, element);
    }
    const next = canonicalSelectedIds.flatMap((id) => {
      const element = elementsById.get(id);
      return element ? [element] : [];
    });
    setTargets((current) => current.length === next.length && current.every((target, index) => target === next[index])
      ? current
      : next);
  }, [activePageId, canonicalSelectedIds, canvasLayer, document]);

  useLayoutEffect(() => {
    scheduleGeometryRefresh();
  }, [activePageId, canvasLayer, document, interactionOverlay, pan.x, pan.y, scheduleGeometryRefresh, targets, zoom]);

  useEffect(() => {
    if (!editorRoot || !canvasLayer) return;
    const refresh = () => scheduleGeometryRefresh();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    resizeObserver?.observe(editorRoot);
    resizeObserver?.observe(canvasLayer);
    targets.forEach((target) => resizeObserver?.observe(target));

    const mutationObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(refresh);
    mutationObserver?.observe(canvasLayer, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    editorRoot.addEventListener("scroll", refresh, true);
    canvasLayer.addEventListener("load", refresh, true);
    canvasLayer.addEventListener("error", refresh, true);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);

    const fonts = (globalThis.document as Document & { fonts?: FontFaceSet }).fonts;
    let active = true;
    if (fonts) {
      void fonts.ready.then(() => { if (active) refresh(); });
      fonts.addEventListener("loadingdone", refresh);
      fonts.addEventListener("loadingerror", refresh);
    }

    for (const image of canvasLayer.querySelectorAll("img")) {
      if (typeof image.decode === "function") void image.decode().then(refresh).catch(refresh);
    }

    return () => {
      active = false;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      editorRoot.removeEventListener("scroll", refresh, true);
      canvasLayer.removeEventListener("load", refresh, true);
      canvasLayer.removeEventListener("error", refresh, true);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      fonts?.removeEventListener("loadingdone", refresh);
      fonts?.removeEventListener("loadingerror", refresh);
    };
  }, [canvasLayer, editorRoot, scheduleGeometryRefresh, targets]);

  const handleWheel = (event: React.WheelEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const cursor = clientPointInViewport(
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      );
      const next = viewportTransform.withZoomAt(cursor, zoom * Math.exp(-event.deltaY * .002));
      setViewport({ pan: next.pan, zoom: next.zoom });
    } else {
      setPan({ x: pan.x - event.deltaX, y: pan.y - event.deltaY });
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target as Element;
    const background = !target.closest(".designer-node, .moveable-control-box, .canvas-floatbar");
    const shouldPan = tool === "hand" || spacePressed.current || event.button === 1;
    if (shouldPan) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointerStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
      setPanning(true);
      return;
    }
    if (background) select([]);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!panning) return;
    setPan({
      x: pointerStart.current.panX + event.clientX - pointerStart.current.x,
      y: pointerStart.current.panY + event.clientY - pointerStart.current.y,
    });
  };

  const stopPanning = (event: ReactPointerEvent<HTMLElement>) => {
    if (panning && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanning(false);
    scheduleGeometryRefresh();
  };

  const fitCanvas = useCallback(() => {
    if (!document || !page || !editorRoot || page.children.length === 0) return;
    const frames = page.children
      .map((id) => document.nodes[id])
      .filter((node): node is DesignNode => Boolean(node && !node.archived && node.visible));
    if (frames.length === 0) return;
    const left = Math.min(...frames.map((node) => node.layout.x));
    const top = Math.min(...frames.map((node) => node.layout.y));
    const right = Math.max(...frames.map((node) => node.layout.x + node.layout.width));
    const bottom = Math.max(...frames.map((node) => node.layout.y + node.layout.height));
    const rect = editorRoot.getBoundingClientRect();
    const nextZoom = Math.max(.12, Math.min(1.15, Math.min(
      (rect.width - 140) / (right - left),
      (rect.height - 140) / (bottom - top),
    )));
    setViewport({
      zoom: nextZoom,
      pan: {
        x: (rect.width - (right - left) * nextZoom) / 2 - left * nextZoom,
        y: (rect.height - (bottom - top) * nextZoom) / 2 - top * nextZoom,
      },
    });
  }, [document, editorRoot, page, setViewport]);

  const fitCanvasRef = useRef(fitCanvas);
  useLayoutEffect(() => { fitCanvasRef.current = fitCanvas; }, [fitCanvas]);
  useEffect(() => {
    if (!document || !page) return;
    const frame = requestAnimationFrame(() => fitCanvasRef.current());
    return () => cancelAnimationFrame(frame);
  }, [document?.id, page?.id]);

  const dragUpdate = (target: HTMLElement, delta: readonly number[]) => {
    const node = nodeForTarget(document, target);
    if (!node) return null;
    restoreCanonicalGeometry(target, node);
    const dx = normalizeGeometryNumber(delta[0] ?? 0);
    const dy = normalizeGeometryNumber(delta[1] ?? 0);
    if (dx === 0 && dy === 0) return null;
    return {
      nodeId: node.id,
      patch: {
        layout: {
          x: normalizeGeometryNumber(node.layout.x + dx),
          y: normalizeGeometryNumber(node.layout.y + dy),
        },
      },
    };
  };

  const resolveAutoLayoutDrop = useCallback((node: DesignNode, point: { x: number; y: number }) => {
    if (!document || !canvasLayer) return null;
    const currentParent = parentOf(document, node.id);
    if (!currentParent || !("node_id" in currentParent)) return null;
    const currentParentNode = document.nodes[currentParent.node_id];
    if (!currentParentNode || currentParentNode.layout.mode === "absolute") return null;

    const elementsById = new Map<NodeId, HTMLElement>();
    for (const element of canvasLayer.querySelectorAll<HTMLElement>(".designer-node[data-node-id]")) {
      const nodeId = element.dataset.nodeId as NodeId | undefined;
      if (nodeId) elementsById.set(nodeId, element);
    }
    const candidates = autoLayoutDropContainers(document, node.id).flatMap((descriptor) => {
      const element = elementsById.get(descriptor.nodeId);
      return element ? [{ ...descriptor, rect: element.getBoundingClientRect() }] : [];
    });
    const destination = chooseAutoLayoutDropContainer(candidates, point, currentParent.node_id);
    if (!destination) return null;
    const destinationNode = document.nodes[destination.nodeId];
    if (!destinationNode) return null;
    const destinationChildren = nodeChildren(destinationNode).filter((childId) => childId !== node.id);
    const siblingGeometry = destinationChildren.flatMap((childId, index) => {
      const sibling = document.nodes[childId];
      const element = elementsById.get(childId);
      if (!sibling || sibling.archived || !sibling.visible || sibling.locked || !element) return [];
      return [{ index, rect: element.getBoundingClientRect() }];
    });
    return {
      parent: { node_id: destination.nodeId } as const,
      index: autoLayoutInsertionIndex(
        destination.mode,
        destination.wrap,
        siblingGeometry,
        point,
        destinationChildren.length,
      ),
    };
  }, [canvasLayer, document]);

  const frameLabels = useMemo(() => {
    if (!document || !page) return [];
    return page.children.flatMap((id) => {
      const node = document.nodes[id];
      if (!node || node.archived || !node.visible) return [];
      return [{ id, name: node.name, width: node.layout.width, height: node.layout.height, x: node.layout.x, y: node.layout.y }];
    });
  }, [document, page]);

  const elementGuidelines = useMemo(() => {
    if (!canvasLayer || targets.length === 0) return [];
    return [...canvasLayer.querySelectorAll<HTMLElement>(".designer-node:not(.is-hidden)")].filter((candidate) =>
      !targets.some((target) => target === candidate || target.contains(candidate)));
  }, [canvasLayer, document, targets]);

  return (
    <section
      ref={setEditorRoot}
      className={`canvas-viewport canvas-editor-root ${panning ? "is-panning" : ""}`}
      data-tool={tool}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPanning}
      onPointerCancel={stopPanning}
    >
      {document && page ? (
        <div
          ref={setCanvasLayer}
          className="canvas-world canvas-layer"
          style={{ transform: viewportTransform.toCssTransform() }}
        >
          {frameLabels.map((frame) => (
            <div key={`label-${frame.id}`} className="canvas-frame-label" style={{ left: frame.x, top: frame.y - 24 }}>
              {frame.name} <span>{Math.round(frame.width)} × {Math.round(frame.height)}</span>
            </div>
          ))}
          {page.children.map((nodeId) => (
            <NodeView key={nodeId} document={document} nodeId={nodeId} parentMode={null} />
          ))}
        </div>
      ) : (
        <div className="canvas-empty"><div><span><Scan size={23} /></span><strong>No frame on this page</strong><small>Add a responsive frame to begin designing.</small></div></div>
      )}

      <div ref={setInteractionOverlay} className="canvas-interaction-overlay">
        {document && canvasLayer && editorRoot && interactionOverlay && tool === "select" && !prototypeOpen && (
          <Selecto
            container={interactionOverlay}
            rootContainer={editorRoot.ownerDocument.body}
            dragContainer={editorRoot}
            boundContainer={editorRoot}
            selectableTargets={[() => [...canvasLayer.querySelectorAll<HTMLElement>(".designer-node:not(.is-locked):not(.is-hidden)")]]}
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
              const inputEvent = event.inputEvent as MouseEvent | PointerEvent;
              select(ids, inputEvent.shiftKey || inputEvent.metaKey);
            }}
          />
        )}

        {document && editorRoot && interactionOverlay && targets.length > 0 && tool === "select" && !prototypeOpen && (
          <Moveable
            ref={moveableRef}
            target={targets}
            container={interactionOverlay}
            rootContainer={editorRoot.ownerDocument.body}
            dragContainer={editorRoot}
            origin={false}
            draggable={canDragSelection}
            resizable={canResizeSelection}
            snappable
            snapThreshold={6}
            elementGuidelines={elementGuidelines}
            bounds={undefined}
            throttleDrag={0}
            throttleResize={0}
            useResizeObserver
            useMutationObserver
            useAccuratePosition
            onDrag={(event) => {
              const node = nodeForTarget(document, event.target as HTMLElement);
              if (node) setDraftTranslation(event.target as HTMLElement, node, event.beforeTranslate as [number, number]);
            }}
            onDragEnd={(event) => {
              const target = event.target as HTMLElement;
              const node = nodeForTarget(document, target);
              if (node && parentLayoutModeForNode(document, node.id) !== "absolute"
                && parentLayoutModeForNode(document, node.id) !== undefined) {
                const drop = event.lastEvent
                  ? resolveAutoLayoutDrop(node, { x: event.clientX, y: event.clientY })
                  : null;
                restoreCanonicalGeometry(target, node);
                if (drop) moveNodeByGesture(node.id, drop.parent, drop.index);
              } else {
                const update = dragUpdate(target, event.lastEvent?.beforeTranslate ?? [0, 0]);
                if (update) updateNodes([update]);
              }
              scheduleGeometryRefresh();
            }}
            onDragGroup={(event) => event.events.forEach((item) => {
              const target = item.target as HTMLElement;
              const node = nodeForTarget(document, target);
              if (node) setDraftTranslation(target, node, item.beforeTranslate as [number, number]);
            })}
            onDragGroupEnd={(event) => {
              const updates = event.events.flatMap((item) => {
                const update = dragUpdate(item.target as HTMLElement, item.lastEvent?.beforeTranslate ?? [0, 0]);
                return update ? [update] : [];
              });
              if (updates.length > 0) updateNodes(updates);
              scheduleGeometryRefresh();
            }}
            onResize={(event) => {
              const target = event.target as HTMLElement;
              const node = nodeForTarget(document, target);
              if (!node) return;
              target.style.width = `${event.width}px`;
              target.style.height = `${event.height}px`;
              setDraftTranslation(target, node, event.drag.beforeTranslate as [number, number]);
            }}
            onResizeEnd={(event) => {
              const target = event.target as HTMLElement;
              const node = nodeForTarget(document, target);
              const last = event.lastEvent;
              if (!node) return;
              restoreCanonicalGeometry(target, node, true);
              if (last) {
                const patch = resizePatchForGesture(node, parentLayoutModeForNode(document, node.id), {
                  width: last.width,
                  height: last.height,
                  direction: last.direction ?? [1, 1],
                  translation: last.drag.beforeTranslate,
                });
                if (patch) updateNodes([{ nodeId: node.id, patch }]);
              }
              scheduleGeometryRefresh();
            }}
          />
        )}
      </div>

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
      <NodeView document={document} nodeId={rootId} parentMode={null} interactive={false} prototype onPrototypeNavigate={onNavigate} />
    </div>
  );
}
