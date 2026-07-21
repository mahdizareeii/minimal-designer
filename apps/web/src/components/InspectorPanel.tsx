import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Box,
  Circle,
  Clock3,
  Copy,
  CornerDownRight,
  Grid2X2,
  Image,
  Eye,
  Layers3,
  Link2,
  List,
  Plus,
  RotateCcw,
  Rows3,
  Sparkles,
  Square,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getDescendantIds, type UpdateNodePatch } from "@designer/core";

import {
  isNodeContainer,
  linksForNode,
  parentOf,
  rawNumber,
  rawString,
  tokenCategory,
  type DesignNode,
  type DesignToken,
  type NodeId,
  type PageId,
  type TokenId,
} from "../domain";
import {
  INSPECTOR_UTILITY_TABS,
  PRIMARY_INSPECTOR_TABS,
  isPrimaryInspectorTab,
  type PrimaryInspectorTab,
} from "../lib/editor-information-architecture";
import { createTokenDraft, useDesignerStore } from "../store/designer-store";
import { navigate } from "../App";

function NodeTypeIcon({ node }: { node: DesignNode }) {
  const props = { size: 14, strokeWidth: 1.7 };
  if (node.type === "text") return <Type {...props} />;
  if (node.type === "ellipse") return <Circle {...props} />;
  if (node.type === "image") return <Image {...props} />;
  if (node.type === "icon") return <Sparkles {...props} />;
  if (node.type === "frame") return <Layers3 {...props} />;
  if (node.type === "group" || node.type === "component") return <Box {...props} />;
  return <Square {...props} />;
}

function NumberField({ label, value, onChange, min }: { label: string; value: number; onChange: (value: number) => void; min?: number }) {
  return (
    <label className="inspector-field"><span>{label}</span><input type="number" value={Number.isFinite(value) ? value : 0} min={min} onChange={(event) => onChange(Number(event.target.value))} /></label>
  );
}

export function AccessibilityIdentityEditor({
  node,
  updateNode,
}: {
  node: DesignNode;
  updateNode: (nodeId: NodeId, patch: UpdateNodePatch) => void;
}) {
  const accessibilityLabel = typeof node.metadata.accessible_label === "string"
    ? node.metadata.accessible_label
    : node.type === "image"
      ? node.alt
      : node.type === "icon"
        ? node.label ?? ""
        : "";
  return (
    <div className="inspector-section">
      <div className="inspector-section-title"><span>Accessible identity</span><Eye size={11} /></div>
      <label className="inspector-field wide"><span>Label</span><input value={accessibilityLabel} placeholder={node.name} onChange={(event) => updateNode(node.id, { accessibility_label: event.target.value || null })} /></label>
      {node.type === "image" && <label className="inspector-field wide" style={{ marginTop: 7 }}><span>Alt</span><input value={node.alt} onChange={(event) => updateNode(node.id, { alt: event.target.value })} /></label>}
      {node.type === "icon" && <label className="inspector-field wide" style={{ marginTop: 7 }}><span>Icon</span><input value={node.label ?? ""} onChange={(event) => updateNode(node.id, { label: event.target.value || null })} /></label>}
      {node.type === "frame" && <label className="inspector-field wide" style={{ marginTop: 7 }}><span>Role</span><select value={node.role ?? "none"} onChange={(event) => updateNode(node.id, { role: event.target.value === "none" ? null : event.target.value as NonNullable<typeof node.role> })}>
        {['none', 'screen', 'section', 'navigation', 'main', 'aside', 'header', 'footer', 'button', 'form', 'list', 'dialog'].map((role) => <option value={role} key={role}>{role}</option>)}
      </select></label>}
    </div>
  );
}

function DesignInspector({ node, tab }: { node: DesignNode; tab: PrimaryInspectorTab }) {
  const document = useDesignerStore((state) => state.document)!;
  const updateNode = useDesignerStore((state) => state.updateNode);
  const setNodePrototype = useDesignerStore((state) => state.setNodePrototype);
  const duplicateSelection = useDesignerStore((state) => state.duplicateSelection);
  const deleteSelection = useDesignerStore((state) => state.deleteSelection);
  const reparentSelection = useDesignerStore((state) => state.reparentSelection);
  const uploadImage = useDesignerStore((state) => state.uploadImage);
  const typography = node.style.typography ?? {};
  const fill = rawString(node.style.fill, "#ffffff");
  const color = rawString(node.style.color, "#111827");
  const radius = node.style.radius && typeof node.style.radius === "object" && !("token_id" in node.style.radius)
    ? rawNumber(node.style.radius.top_left, 0)
    : rawNumber(node.style.radius, 0);
  const opacity = rawNumber(node.style.opacity, 1);
  const existingLink = linksForNode(document, node.id).find((link) => link.trigger.type === "click");
  const targetPage = existingLink && (existingLink.action.type === "navigate" || existingLink.action.type === "open_overlay")
    ? existingLink.action.page_id
    : "";
  const setStyle = (patch: Partial<DesignNode["style"]>) => updateNode(node.id, { style: { ...node.style, ...patch } });
  const setTypography = (patch: typeof typography) => setStyle({ typography: { ...typography, ...patch } });
  const currentParent = parentOf(document, node.id);
  const parentValue = currentParent
    ? "node_id" in currentParent ? `node:${currentParent.node_id}` : `page:${currentParent.page_id}`
    : "";
  const excludedParents = new Set([node.id, ...getDescendantIds(document, node.id, { includeArchived: true })]);
  const containerParents = Object.values(document.nodes).filter((candidate) =>
    isNodeContainer(candidate) && !candidate.archived && !excludedParents.has(candidate.id));
  const metadataText = (key: string) => typeof node.metadata[key] === "string" ? node.metadata[key] as string : "";
  const setMetadataText = (key: string, value: string) => updateNode(node.id, {
    metadata: { ...node.metadata, [key]: value },
    metadata_mode: "replace",
  });

  return (
    <>
      <div className="selection-summary">
        <span className="selection-summary-icon"><NodeTypeIcon node={node} /></span>
        <div><strong>{node.name}</strong><span>{node.type} · {node.id.slice(-8)}</span></div>
      </div>

      {tab === "design" && <>
      <div className="inspector-section">
        <div className="inspector-section-title"><span>Layer</span><span><button className="icon-button" onClick={duplicateSelection} aria-label="Duplicate"><Copy size={11} /></button><button className="icon-button" onClick={deleteSelection} aria-label="Delete"><Trash2 size={11} /></button></span></div>
        <div className="inspector-grid">
          <label className="inspector-field wide"><span>N</span><input value={node.name} onChange={(event) => updateNode(node.id, { name: event.target.value || "Untitled layer" })} /></label>
          <label className="inspector-field wide"><span>P</span><select value={parentValue} onChange={(event) => {
            const [kind, id] = event.target.value.split(":", 2);
            if (!id) return;
            reparentSelection(kind === "page" ? { page_id: id as PageId } : { node_id: id as NodeId });
          }}>
            {document.pages.filter((page) => !page.archived).map((page) => <option key={page.id} value={`page:${page.id}`}>Page · {page.name}</option>)}
            {containerParents.map((candidate) => <option key={candidate.id} value={`node:${candidate.id}`}>{candidate.type} · {candidate.name}</option>)}
          </select></label>
        </div>
      </div>

      <div className="inspector-section">
        <div className="inspector-section-title"><span>Position & size</span><span>px</span></div>
        <div className="inspector-grid">
          <NumberField label="X" value={node.layout.x} onChange={(x) => updateNode(node.id, { layout: { x } })} />
          <NumberField label="Y" value={node.layout.y} onChange={(y) => updateNode(node.id, { layout: { y } })} />
          <NumberField label="W" value={node.layout.width} min={1} onChange={(width) => updateNode(node.id, { layout: { width: Math.max(1, width) } })} />
          <NumberField label="H" value={node.layout.height} min={1} onChange={(height) => updateNode(node.id, { layout: { height: Math.max(1, height) } })} />
          <label className="inspector-field"><span>W mode</span><select value={node.layout.width_sizing} onChange={(event) => updateNode(node.id, { layout: { width_sizing: event.target.value as "fixed" | "fill" | "hug" } })}><option value="fixed">Fixed</option><option value="fill">Fill</option><option value="hug">Hug</option></select></label>
          <label className="inspector-field"><span>H mode</span><select value={node.layout.height_sizing} onChange={(event) => updateNode(node.id, { layout: { height_sizing: event.target.value as "fixed" | "fill" | "hug" } })}><option value="fixed">Fixed</option><option value="fill">Fill</option><option value="hug">Hug</option></select></label>
        </div>
      </div>

      {(node.type === "frame" || node.type === "group" || node.type === "component") && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Layout</span><span>{node.layout.mode}</span></div>
          <div className="segmented-control">
            <button className={node.layout.mode === "absolute" ? "is-active" : ""} onClick={() => updateNode(node.id, { layout: { mode: "absolute" } })} title="Free layout"><CornerDownRight size={12} /></button>
            <button className={node.layout.mode === "horizontal" ? "is-active" : ""} onClick={() => updateNode(node.id, { layout: { mode: "horizontal" } })} title="Horizontal stack"><List size={12} /></button>
            <button className={node.layout.mode === "vertical" ? "is-active" : ""} onClick={() => updateNode(node.id, { layout: { mode: "vertical" } })} title="Vertical stack"><Rows3 size={12} /></button>
            <button className={node.layout.mode === "grid" ? "is-active" : ""} onClick={() => updateNode(node.id, { layout: { mode: "grid", columns: node.layout.columns ?? 2 } })} title="Grid"><Grid2X2 size={12} /></button>
          </div>
          <div className="inspector-grid" style={{ marginTop: 7 }}>
            <NumberField label="Gap" value={rawNumber(node.layout.gap, 0)} min={0} onChange={(gap) => updateNode(node.id, { layout: { gap } })} />
            <NumberField label="Pad" value={typeof node.layout.padding === "number" ? node.layout.padding : 0} min={0} onChange={(padding) => updateNode(node.id, { layout: { padding } })} />
            {node.layout.mode === "grid" && <NumberField label="Cols" value={node.layout.columns ?? 2} min={1} onChange={(columns) => updateNode(node.id, { layout: { columns: Math.max(1, Math.round(columns)) } })} />}
            <label className="inspector-field"><span>Align</span><select value={node.layout.align_items ?? "start"} onChange={(event) => updateNode(node.id, { layout: { align_items: event.target.value as "start" | "center" | "end" | "stretch" | "baseline" } })}><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="stretch">Stretch</option><option value="baseline">Baseline</option></select></label>
            <label className="inspector-field"><span>Justify</span><select value={node.layout.justify_content ?? "start"} onChange={(event) => updateNode(node.id, { layout: { justify_content: event.target.value as "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly" } })}><option value="start">Start</option><option value="center">Center</option><option value="end">End</option><option value="space-between">Between</option><option value="space-around">Around</option><option value="space-evenly">Evenly</option></select></label>
            {node.type === "frame" && <label className="inspector-field wide"><span>Clip</span><input type="checkbox" checked={node.clip_content} onChange={(event) => updateNode(node.id, { clip_content: event.target.checked })} /></label>}
          </div>
        </div>
      )}

      <div className="inspector-section">
        <div className="inspector-section-title"><span>Appearance</span><span>{Math.round(opacity * 100)}%</span></div>
        <div className="color-row">
          <label className="color-swatch"><input type="color" value={fill.startsWith("#") ? fill : "#ffffff"} onChange={(event) => setStyle({ fill: event.target.value })} /></label>
          <input className="plain-input" value={fill} onChange={(event) => setStyle({ fill: event.target.value })} aria-label="Fill" />
          <input className="plain-input" type="number" min={0} max={100} value={Math.round(opacity * 100)} onChange={(event) => setStyle({ opacity: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} aria-label="Opacity" />
        </div>
        <div className="inspector-grid" style={{ marginTop: 7 }}>
          <NumberField label="R" value={radius} min={0} onChange={(value) => setStyle({ radius: value })} />
          <NumberField label="Rot" value={node.layout.rotation ?? 0} onChange={(rotation) => updateNode(node.id, { layout: { rotation } })} />
        </div>
      </div>
      </>}

      {tab === "content" && node.type === "text" && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Typography</span><span>Mixed / RTL</span></div>
          <label className="inspector-field textarea-field wide"><textarea value={node.content} dir={node.direction ?? "auto"} onChange={(event) => updateNode(node.id, { content: event.target.value })} /></label>
          <div className="inspector-grid" style={{ marginTop: 7 }}>
            <label className="inspector-field"><span>F</span><input value={rawString(typography.font_family, "Inter")} onChange={(event) => setTypography({ font_family: event.target.value })} /></label>
            <NumberField label="Sz" value={rawNumber(typography.font_size, 16)} min={1} onChange={(font_size) => setTypography({ font_size })} />
            <NumberField label="Wt" value={typeof typography.font_weight === "number" ? typography.font_weight : 500} min={1} onChange={(font_weight) => setTypography({ font_weight })} />
            <label className="inspector-field"><span>Dir</span><select value={node.direction ?? "auto"} onChange={(event) => updateNode(node.id, { direction: event.target.value as "auto" | "ltr" | "rtl" })}><option value="auto">Auto</option><option value="ltr">LTR</option><option value="rtl">RTL</option></select></label>
          </div>
          <div className="segmented-control" style={{ marginTop: 7 }}>
            <button className={typography.text_align === "left" ? "is-active" : ""} onClick={() => setTypography({ text_align: "left" })}><AlignLeft size={12} /></button>
            <button className={typography.text_align === "center" ? "is-active" : ""} onClick={() => setTypography({ text_align: "center" })}><AlignCenter size={12} /></button>
            <button className={typography.text_align === "right" ? "is-active" : ""} onClick={() => setTypography({ text_align: "right" })}><AlignRight size={12} /></button>
          </div>
          <div className="color-row" style={{ marginTop: 7 }}>
            <label className="color-swatch"><input type="color" value={color.startsWith("#") ? color : "#111827"} onChange={(event) => setStyle({ color: event.target.value })} /></label>
            <input className="plain-input" value={color} onChange={(event) => setStyle({ color: event.target.value })} aria-label="Text color" />
          </div>
        </div>
      )}

      {tab === "content" && node.type === "image" && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Image asset</span><Image size={11} /></div>
          <label className="button button-secondary" style={{ width: "100%", minHeight: 31, fontSize: 9, cursor: "pointer" }}>
            <Upload size={12} /> Upload PNG, JPEG, or WebP
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadImage(node.id, file);
                event.target.value = "";
              }}
            />
          </label>
          <label className="inspector-field wide" style={{ marginTop: 7 }}><span>Alt</span><input value={node.alt} onChange={(event) => updateNode(node.id, { alt: event.target.value })} /></label>
        </div>
      )}

      {tab === "content" && node.type === "icon" && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Bundled icon</span><Sparkles size={11} /></div>
          <label className="inspector-field wide"><span>Icon</span><input value={node.icon_name} onChange={(event) => updateNode(node.id, { icon_name: event.target.value || "circle" })} /></label>
          <label className="inspector-field wide" style={{ marginTop: 7 }}><span>Label</span><input value={node.label ?? ""} onChange={(event) => updateNode(node.id, { label: event.target.value || null })} /></label>
        </div>
      )}

      {tab === "content" && node.type !== "text" && node.type !== "image" && node.type !== "icon" && (
        <div className="inspector-tab-empty"><Type size={16} /><strong>No direct content</strong><small>This layer contains layout or shape data. Select a text, image, or icon child to edit its content.</small></div>
      )}

      {tab === "component" && node.type === "component" && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Component definition</span><Box size={11} /></div>
          <label className="inspector-field wide"><span>Key</span><input value={node.component_key} onChange={(event) => updateNode(node.id, { component_key: event.target.value || "project.component" })} /></label>
          <label className="inspector-field textarea-field wide" style={{ marginTop: 7 }}><span>Description</span><textarea value={node.description ?? ""} onChange={(event) => updateNode(node.id, { description: event.target.value || null })} /></label>
          <p className="inspector-note">V1 definitions are project-local drafts. Publishing, version pinning, states, slots, and upgrade previews are managed by the V2 design-system workspace.</p>
        </div>
      )}

      {tab === "component" && node.type === "instance" && (
        <div className="inspector-section">
          <div className="inspector-section-title"><span>Component instance</span><Box size={11} /></div>
          <div className="inspector-readonly-row"><span>Definition</span><code>{node.component_id}</code></div>
          <div className="inspector-readonly-row"><span>Overrides</span><code>{Object.keys(node.overrides).length}</code></div>
          <pre className="inspector-json-preview">{JSON.stringify(node.overrides, null, 2)}</pre>
        </div>
      )}

      {tab === "component" && node.type !== "component" && node.type !== "instance" && (
        <div className="inspector-tab-empty"><Box size={16} /><strong>Detached layer</strong><small>This node is not linked to a component definition. Inserted V1 templates intentionally remain editable detached trees.</small></div>
      )}

      {tab === "logic" && (
        <>
          <div className="inspector-section">
            <div className="inspector-section-title"><span>Business logic</span><span>Structured handoff</span></div>
            <label className="inspector-field textarea-field wide"><textarea value={metadataText("business_logic")} placeholder="Describe conditions, permissions, validation, and outcomes for this entity." onChange={(event) => setMetadataText("business_logic", event.target.value)} /></label>
            <label className="inspector-field textarea-field wide" style={{ marginTop: 7 }}><textarea value={metadataText("acceptance_notes")} placeholder="Acceptance notes linked to this design entity." onChange={(event) => setMetadataText("acceptance_notes", event.target.value)} /></label>
          </div>
          <div className="inspector-section">
            <div className="inspector-section-title"><span>Tags</span><span>{node.tags?.length ?? 0}</span></div>
            <label className="inspector-field wide"><span>#</span><input value={(node.tags ?? []).join(", ")} placeholder="checkout, authenticated, critical" onChange={(event) => updateNode(node.id, {
              tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 32),
            })} /></label>
          </div>
        </>
      )}

      {tab === "prototype" && <div className="inspector-section">
        <div className="inspector-section-title"><span>Prototype</span><Link2 size={11} /></div>
        <select
          className="prototype-target"
          value={targetPage}
          onChange={(event) => { if (event.target.value) setNodePrototype(node.id, event.target.value as PageId); }}
        >
          <option value="" disabled>Choose target…</option>
          {document.pages.filter((page) => !page.archived).map((page) => <option key={page.id} value={page.id}>On click → {page.name}</option>)}
        </select>
      </div>}

      {tab === "accessibility" && (
        <>
          <AccessibilityIdentityEditor node={node} updateNode={updateNode} />
          <div className="inspector-section">
            <div className="inspector-section-title"><span>Touch target</span><span>{node.layout.width >= 44 && node.layout.height >= 44 ? "Pass" : "Review"}</span></div>
            <div className={`accessibility-check ${node.layout.width >= 44 && node.layout.height >= 44 ? "is-pass" : "is-warning"}`}>
              <strong>{Math.round(node.layout.width)} × {Math.round(node.layout.height)} px</strong>
              <small>Interactive targets should be at least 44 × 44 CSS px unless the element is intentionally non-interactive.</small>
            </div>
          </div>
          {node.type === "text" && <div className="inspector-section">
            <div className="inspector-section-title"><span>Text direction</span><span>{node.direction ?? "auto"}</span></div>
            <label className="inspector-field wide"><span>Dir</span><select value={node.direction ?? "auto"} onChange={(event) => updateNode(node.id, { direction: event.target.value as "auto" | "ltr" | "rtl" })}><option value="auto">Automatic mixed direction</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>
          </div>}
        </>
      )}
    </>
  );
}

function TokensPanel() {
  const document = useDesignerStore((state) => state.document)!;
  const upsertToken = useDesignerStore((state) => state.upsertToken);
  const deleteToken = useDesignerStore((state) => state.deleteToken);
  const [draft, setDraft] = useState<DesignToken>(() => createTokenDraft());
  const tokens = useMemo(() => Object.values(document.tokens).filter((token) => !token.archived), [document.tokens]);
  const groups = ["colors", "spacing", "typography", "other"] as const;
  const add = () => {
    upsertToken({ ...draft, name: draft.name.trim() || "Untitled token", path: draft.path.trim() || `custom.${draft.id.slice(-6)}` });
    setDraft(createTokenDraft(draft.kind));
  };

  return (
    <div className="right-sidebar-scroll">
      <div className="panel-toolbar">
        <p>Shared tokens keep Codex and human edits visually consistent.</p>
        <div className="inspector-grid">
          <input className="plain-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-label="Token name" />
          <input className="plain-input" value={String(draft.value)} onChange={(event) => setDraft({
            ...draft,
            value: draft.kind === "dimension" || draft.kind === "number" || draft.kind === "font_weight"
              ? Number(event.target.value)
              : event.target.value,
          })} aria-label="Token value" />
          <select className="plain-input" value={draft.kind} onChange={(event) => setDraft(createTokenDraft(event.target.value as DesignToken["kind"]))} aria-label="Token kind">
            <option value="color">Color</option>
            <option value="dimension">Dimension</option>
            <option value="number">Number</option>
            <option value="font_family">Font family</option>
            <option value="font_weight">Font weight</option>
          </select>
          <input className="plain-input" value={draft.path} onChange={(event) => setDraft({ ...draft, path: event.target.value })} aria-label="Token path" />
        </div>
        <button className="button button-secondary" style={{ marginTop: 7 }} onClick={add}><Plus size={12} /> Add token</button>
      </div>
      {groups.map((group) => {
        const items = tokens.filter((token) => tokenCategory(token) === group);
        if (items.length === 0) return null;
        return (
          <div className="token-group" key={group}>
            <h4>{group}</h4>
            {items.map((token) => (
              <div className="token-row" key={token.id}>
                <span className="token-preview" style={token.kind === "color" ? { background: String(token.value) } : {}}>{token.kind === "color" ? "" : String(token.value)}</span>
                <div><strong>{token.name}</strong><small>{token.path} · {String(token.value)}</small></div>
                <button onClick={() => deleteToken(token.id)} aria-label={`Delete ${token.name}`}><Trash2 size={11} /></button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function HistoryPanel() {
  const document = useDesignerStore((state) => state.document);
  const revisions = useDesignerStore((state) => state.revisions);
  const loading = useDesignerStore((state) => state.historyLoading);
  const loadHistory = useDesignerStore((state) => state.loadHistory);
  const restoreRevision = useDesignerStore((state) => state.restoreRevision);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  return (
    <div className="right-sidebar-scroll">
      <div className="panel-toolbar"><p>Every human and Codex commit is immutable. Restoring creates a new revision.</p><button className="button button-secondary" onClick={() => void loadHistory()}><RotateCcw size={12} /> Refresh history</button></div>
      {loading ? <div className="panel-loading">Loading revisions…</div> : (
        <div className="history-list">
          {revisions.map((revision, index) => (
            <div className="history-row" key={revision.id}>
              <span className="history-dot" />
              <strong>{revision.message || "Saved revision"}</strong>
              <small><Clock3 size={9} /> v{revision.version} · {new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(revision.createdAt))}</small>
              <div className="history-actions">
                {document && <button onClick={() => navigate(`/projects/${encodeURIComponent(document.id)}/revisions/${encodeURIComponent(revision.id)}/inspect`)}><Eye size={9} /> Inspect</button>}
                {index > 0 && <button onClick={() => void restoreRevision(revision.version)}>Restore</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function InspectorPanel() {
  const document = useDesignerStore((state) => state.document);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const tab = useDesignerStore((state) => state.inspectorTab);
  const setTab = useDesignerStore((state) => state.setInspectorTab);
  const node = selectedIds.length === 1 ? document?.nodes[selectedIds[0]!] : undefined;

  return (
    <aside className="right-sidebar">
      <nav className="sidebar-tabs inspector-primary-tabs" aria-label="Inspector workspace">
        {PRIMARY_INSPECTOR_TABS.map((item) => (
          <button
            key={item}
            className={`sidebar-tab ${tab === item ? "is-active" : ""}`}
            aria-pressed={tab === item}
            onClick={() => setTab(item)}
          >{item}</button>
        ))}
      </nav>
      <nav className="inspector-utility-tabs" aria-label="Inspector utilities">
        {INSPECTOR_UTILITY_TABS.map((item) => (
          <button key={item} className={tab === item ? "is-active" : ""} aria-pressed={tab === item} onClick={() => setTab(item)}>
            {item === "tokens" ? <Sparkles size={10} /> : <Clock3 size={10} />}{item}
          </button>
        ))}
      </nav>
      {tab === "tokens" && document ? <TokensPanel /> : tab === "history" ? <HistoryPanel /> : (
        <div className="right-sidebar-scroll">
          {node && !node.archived && isPrimaryInspectorTab(tab) ? <DesignInspector node={node} tab={tab} /> : (
            <div className="empty-inspector"><span><Square size={16} /></span><strong>{selectedIds.length > 1 ? `${selectedIds.length} layers selected` : "Nothing selected"}</strong><small>Select one layer to inspect its design, content, component contract, logic, prototype, and accessibility.</small></div>
          )}
        </div>
      )}
    </aside>
  );
}
