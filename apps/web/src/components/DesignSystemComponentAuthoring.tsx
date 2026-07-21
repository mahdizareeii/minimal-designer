import {
  ComponentDefinitionSchema,
  type ComponentDefinition,
  type ComponentProperty,
} from "@designer/core";
import { Boxes, Check, CircleAlert, LoaderCircle, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDesignSystemComponentDraft,
  listDesigns,
  listHistory,
  readDesignSystemComponentCatalog,
  readRevisionInspect,
  transitionDesignSystemComponent,
  type ComponentSourceReference,
  type ComponentDefinitionSubmission,
  type ComponentDefinitionCatalogRecord,
  type DesignSystemRecord,
  type RevisionInspectResult,
} from "../lib/api";
import type { DesignProjectSummary, RevisionSummary } from "../domain";

const PROPERTY_TYPES = ["text", "boolean", "enum", "icon", "asset", "node_slot"] as const;
const STATE_TYPES = ["default", "hover", "pressed", "focused", "disabled", "loading", "error", "selected"] as const;
const NODE_TYPES = ["frame", "container", "text", "rectangle", "ellipse", "image", "icon", "component_instance"] as const;

type PropertyType = typeof PROPERTY_TYPES[number];
type StateType = typeof STATE_TYPES[number];

export interface ComponentPropertyDraft {
  key: string;
  label: string;
  type: PropertyType;
  required: boolean;
  defaultValue: string;
  enumValues: string;
  minItems: number;
  maxItems: number;
}

export interface ComponentSlotDraft {
  key: string;
  name: string;
  required: boolean;
  minItems: number;
  maxItems: number;
  allowedNodeTypes: string;
}

export interface ComponentStateDraft {
  key: StateType;
  name: string;
  nodeId: string;
}

export interface ComponentAuthoringDraft {
  componentId: string | null;
  expectedLatestVersion: number;
  key: string;
  name: string;
  rootNodeId: string;
  summary: string;
  properties: ComponentPropertyDraft[];
  slots: ComponentSlotDraft[];
  states: ComponentStateDraft[];
  allowText: boolean;
  allowAssets: boolean;
  allowIcons: boolean;
  preservedDefinition: ComponentDefinition | null;
}

function propertyDraft(): ComponentPropertyDraft {
  return {
    key: "label",
    label: "Label",
    type: "text",
    required: false,
    defaultValue: "",
    enumValues: "default, alternative",
    minItems: 0,
    maxItems: 1,
  };
}

function slotDraft(): ComponentSlotDraft {
  return {
    key: "content",
    name: "Content",
    required: false,
    minItems: 0,
    maxItems: 1,
    allowedNodeTypes: "text, icon",
  };
}

export function createBlankComponentDraft(): ComponentAuthoringDraft {
  return {
    componentId: null,
    expectedLatestVersion: 0,
    key: "component.new",
    name: "New component",
    rootNodeId: "",
    summary: "",
    properties: [propertyDraft()],
    slots: [],
    states: [{ key: "default", name: "Default", nodeId: "" }],
    allowText: true,
    allowAssets: false,
    allowIcons: false,
    preservedDefinition: null,
  };
}

export interface ComponentSourceNodeOption {
  id: string;
  name: string;
}

export function componentSourceNodeOptions(inspect: RevisionInspectResult | null): ComponentSourceNodeOption[] {
  if (!inspect || inspect.document.schema_version !== 2) return [];
  return Object.values(inspect.document.nodes)
    .filter((node) => node.type === "container" && node.visible && !node.archived)
    .map((node) => ({ id: node.id, name: node.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function splitValues(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function propertyFromDraft(property: ComponentPropertyDraft, preserved?: ComponentProperty): unknown {
  const preservedDescription = preserved?.description === undefined ? {} : { description: preserved.description };
  const base = {
    key: property.key.trim(),
    label: property.label.trim(),
    required: property.required,
    ...preservedDescription,
  };
  if (property.type === "text") return {
    ...base,
    type: "text",
    ...(preserved?.type === "text" && preserved.max_length !== undefined ? { max_length: preserved.max_length } : {}),
    ...(property.defaultValue ? { default: property.defaultValue } : {}),
  };
  if (property.type === "boolean") return {
    ...base,
    type: "boolean",
    ...(property.defaultValue ? { default: property.defaultValue === "true" } : {}),
  };
  if (property.type === "enum") return {
    ...base,
    type: "enum",
    values: splitValues(property.enumValues),
    ...(property.defaultValue ? { default: property.defaultValue.trim() } : {}),
  };
  if (property.type === "icon") return {
    ...base,
    type: "icon",
    ...(property.defaultValue ? { default: property.defaultValue.trim() } : {}),
  };
  if (property.type === "asset") return {
    ...base,
    type: "asset",
    accepted_mime_types: preserved?.type === "asset"
      ? preserved.accepted_mime_types
      : ["image/png", "image/jpeg", "image/webp"],
    ...(property.defaultValue ? { default_asset_id: property.defaultValue.trim() } : {}),
  };
  return {
    ...base,
    type: "node_slot",
    min_items: property.minItems,
    max_items: property.maxItems,
  };
}

export function buildComponentDraftDefinition(draft: ComponentAuthoringDraft): ComponentDefinitionSubmission {
  const preservedProperties = new Map(
    (draft.preservedDefinition?.properties_schema ?? []).map((property) => [property.key, property]),
  );
  const definition = ComponentDefinitionSchema.parse({
    id: draft.componentId ?? "component_clientvalidation0001",
    key: draft.key.trim(),
    name: draft.name.trim(),
    version: draft.expectedLatestVersion + 1,
    status: "draft",
    root_node_id: draft.rootNodeId.trim(),
    properties_schema: draft.properties.map((property) => propertyFromDraft(property, preservedProperties.get(property.key))),
    slots: draft.slots.map((slot) => ({
      key: slot.key.trim(),
      name: slot.name.trim(),
      required: slot.required,
      min_items: slot.minItems,
      max_items: slot.maxItems,
      ...(splitValues(slot.allowedNodeTypes).length > 0
        ? { allowed_node_types: splitValues(slot.allowedNodeTypes) }
        : {}),
    })),
    states: draft.states.map((state) => ({
      key: state.key,
      name: state.name.trim(),
      node_id: state.nodeId.trim(),
    })),
    allowed_overrides: {
      allow_text: draft.allowText,
      allow_assets: draft.allowAssets,
      allow_icons: draft.allowIcons,
      allowed_token_families: draft.preservedDefinition?.allowed_overrides.allowed_token_families ?? [],
      allowed_style_paths: draft.preservedDefinition?.allowed_overrides.allowed_style_paths ?? [],
    },
    platform_mappings: draft.preservedDefinition?.platform_mappings ?? [],
    documentation: {
      summary: draft.summary,
      usage: draft.preservedDefinition?.documentation.usage ?? [],
      accessibility: draft.preservedDefinition?.documentation.accessibility ?? [],
      do_list: draft.preservedDefinition?.documentation.do_list ?? [],
      dont_list: draft.preservedDefinition?.documentation.dont_list ?? [],
    },
  });
  if (draft.componentId !== null) return definition;
  const { id: _serverGeneratedId, ...submission } = definition;
  return submission;
}

function editorDefaultValue(property: ComponentProperty): string {
  if (property.type === "asset") return property.default_asset_id ?? "";
  if (property.type === "node_slot") return "";
  if (property.default === undefined) return "";
  return String(property.default);
}

export function draftFromComponent(component: ComponentDefinitionCatalogRecord): ComponentAuthoringDraft {
  const definition = component.definition;
  return {
    componentId: component.componentId,
    expectedLatestVersion: component.version,
    key: definition.key,
    name: definition.name,
    rootNodeId: definition.root_node_id,
    summary: definition.documentation.summary,
    properties: definition.properties_schema.map((property) => ({
      key: property.key,
      label: property.label,
      type: property.type,
      required: property.required,
      defaultValue: editorDefaultValue(property),
      enumValues: property.type === "enum" ? property.values.join(", ") : "default, alternative",
      minItems: property.type === "node_slot" ? property.min_items : 0,
      maxItems: property.type === "node_slot" ? property.max_items : 1,
    })),
    slots: definition.slots.map((slot) => ({
      key: slot.key,
      name: slot.name,
      required: slot.required,
      minItems: slot.min_items,
      maxItems: slot.max_items,
      allowedNodeTypes: slot.allowed_node_types?.join(", ") ?? "",
    })),
    states: definition.states.map((state) => ({ key: state.key, name: state.name, nodeId: state.node_id })),
    allowText: definition.allowed_overrides.allow_text,
    allowAssets: definition.allowed_overrides.allow_assets,
    allowIcons: definition.allowed_overrides.allow_icons,
    preservedDefinition: structuredClone(definition),
  };
}

function issueMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The component operation failed.";
  const possibleIssues = (error as Error & { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
  if (possibleIssues?.length) {
    return possibleIssues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" · ");
  }
  return error.message;
}

export function DesignSystemComponentAuthoring({ designSystems }: { designSystems: DesignSystemRecord[] }) {
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [components, setComponents] = useState<ComponentDefinitionCatalogRecord[]>([]);
  const [draft, setDraft] = useState<ComponentAuthoringDraft | null>(null);
  const [sourceDesigns, setSourceDesigns] = useState<DesignProjectSummary[]>([]);
  const [sourceDesignId, setSourceDesignId] = useState("");
  const [sourceRevisions, setSourceRevisions] = useState<RevisionSummary[]>([]);
  const [sourceRevisionId, setSourceRevisionId] = useState("");
  const [sourceInspect, setSourceInspect] = useState<RevisionInspectResult | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [replacementByComponent, setReplacementByComponent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canAuthorComponents, setCanAuthorComponents] = useState(false);
  const [permissionLoaded, setPermissionLoaded] = useState(false);

  useEffect(() => {
    if (!selectedSystemId && designSystems[0]) setSelectedSystemId(designSystems[0].id);
    if (selectedSystemId && !designSystems.some((system) => system.id === selectedSystemId)) {
      setSelectedSystemId(designSystems[0]?.id ?? "");
    }
  }, [designSystems, selectedSystemId]);

  const refresh = useCallback(async () => {
    if (!selectedSystemId) {
      setComponents([]);
      setCanAuthorComponents(false);
      setPermissionLoaded(false);
      return;
    }
    setLoading(true);
    setError(null);
    setPermissionLoaded(false);
    try {
      const catalog = await readDesignSystemComponentCatalog(selectedSystemId);
      setComponents(catalog.components);
      setCanAuthorComponents(catalog.permissions.canAuthorComponents);
      setPermissionLoaded(true);
      if (!catalog.permissions.canAuthorComponents) setDraft(null);
    } catch (cause) {
      setCanAuthorComponents(false);
      setError(issueMessage(cause));
    }
    finally { setLoading(false); }
  }, [selectedSystemId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!canAuthorComponents) {
      setSourceDesigns([]);
      setSourceDesignId("");
      setSourceRevisions([]);
      setSourceRevisionId("");
      setSourceInspect(null);
      return;
    }
    let active = true;
    setSourceLoading(true);
    void listDesigns().then((designs) => {
      if (!active) return;
      setSourceDesigns(designs);
      setSourceDesignId((current) => designs.some((design) => design.id === current)
        ? current
        : designs[0]?.id ?? "");
    }).catch((cause) => {
      if (active) setError(issueMessage(cause));
    }).finally(() => {
      if (active) setSourceLoading(false);
    });
    return () => { active = false; };
  }, [canAuthorComponents]);

  useEffect(() => {
    if (!sourceDesignId) {
      setSourceRevisions([]);
      setSourceRevisionId("");
      setSourceInspect(null);
      return;
    }
    let active = true;
    setSourceLoading(true);
    void listHistory(sourceDesignId).then((revisions) => {
      if (!active) return;
      const ordered = [...revisions].sort((left, right) => right.version - left.version);
      setSourceRevisions(ordered);
      setSourceRevisionId((current) => ordered.some((revision) => revision.id === current)
        ? current
        : ordered[0]?.id ?? "");
    }).catch((cause) => {
      if (!active) return;
      setSourceRevisions([]);
      setSourceRevisionId("");
      setSourceInspect(null);
      setError(issueMessage(cause));
    }).finally(() => {
      if (active) setSourceLoading(false);
    });
    return () => { active = false; };
  }, [sourceDesignId]);

  useEffect(() => {
    if (!sourceDesignId || !sourceRevisionId) {
      setSourceInspect(null);
      return;
    }
    let active = true;
    setSourceLoading(true);
    void readRevisionInspect(sourceDesignId, sourceRevisionId).then((inspect) => {
      if (!active) return;
      setSourceInspect(inspect);
    }).catch((cause) => {
      if (!active) return;
      setSourceInspect(null);
      setError(issueMessage(cause));
    }).finally(() => {
      if (active) setSourceLoading(false);
    });
    return () => { active = false; };
  }, [sourceDesignId, sourceRevisionId]);

  const sourceNodes = useMemo(() => componentSourceNodeOptions(sourceInspect), [sourceInspect]);
  const sourceReference = useMemo<ComponentSourceReference | null>(() => (
    sourceInspect?.document.schema_version === 2 && sourceDesignId && sourceRevisionId
      ? { designId: sourceDesignId, revisionId: sourceRevisionId }
      : null
  ), [sourceDesignId, sourceInspect, sourceRevisionId]);

  useEffect(() => {
    if (!draft || draft.rootNodeId || sourceNodes.length === 0) return;
    const rootNodeId = sourceNodes[0]!.id;
    setDraft({
      ...draft,
      rootNodeId,
      states: draft.states.map((state) => state.key === "default" ? { ...state, nodeId: rootNodeId } : state),
    });
  }, [draft, sourceNodes]);

  const publishedReplacements = useMemo(
    () => components.filter((component) => component.status === "published"),
    [components],
  );

  const requireSourceReference = (): ComponentSourceReference => {
    if (!sourceReference) throw new Error("Choose an exact V2 project revision before authoring a component.");
    return sourceReference;
  };

  const mutate = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(issueMessage(cause)); }
    finally { setBusy(null); }
  };

  const updateProperty = (index: number, patch: Partial<ComponentPropertyDraft>) => {
    setDraft((current) => current ? {
      ...current,
      properties: current.properties.map((property, itemIndex) => itemIndex === index ? { ...property, ...patch } : property),
    } : null);
  };
  const updateSlot = (index: number, patch: Partial<ComponentSlotDraft>) => {
    setDraft((current) => current ? {
      ...current,
      slots: current.slots.map((slot, itemIndex) => itemIndex === index ? { ...slot, ...patch } : slot),
    } : null);
  };
  const updateState = (index: number, patch: Partial<ComponentStateDraft>) => {
    setDraft((current) => current ? {
      ...current,
      states: current.states.map((state, itemIndex) => itemIndex === index ? { ...state, ...patch } : state),
    } : null);
  };

  return (
    <section className="administration-card component-authoring-card">
      <div className="administration-card-heading">
        <div><span><Boxes size={18} /></span><div><h2>Component catalog</h2><p>Typed contracts, immutable versions, lifecycle state, and replacement diagnostics.</p></div></div>
        {designSystems.length > 0 && <div className="component-authoring-actions">
          <select aria-label="Component design system" value={selectedSystemId} onChange={(event) => {
            setSelectedSystemId(event.target.value);
            setDraft(null);
            setCanAuthorComponents(false);
            setPermissionLoaded(false);
          }}>
            {designSystems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
          </select>
          {permissionLoaded && canAuthorComponents && <button
            className="button button-primary"
            disabled={busy !== null || !sourceReference || sourceNodes.length === 0}
            title={!sourceReference || sourceNodes.length === 0 ? "Choose a V2 source revision with at least one visible container." : undefined}
            onClick={() => setDraft(createBlankComponentDraft())}
          ><Plus size={14} /> New component</button>}
        </div>}
      </div>

      {error && <div className="component-authoring-message is-error"><CircleAlert size={14} /> {error}</div>}
      {notice && <div className="component-authoring-message"><Check size={14} /> {notice}</div>}
      {permissionLoaded && !canAuthorComponents && <div className="component-authoring-message"><Boxes size={14} /> Read-only component catalog. Your current organization role cannot create drafts or change component lifecycle state.</div>}
      {permissionLoaded && canAuthorComponents && <div className="component-source-picker">
        <div>
          <strong>Exact component source</strong>
          <small>Choose an immutable V2 revision. State roots are selected from real visible container nodes; source bytes and hashes are captured by the server.</small>
        </div>
        <label>Project<select aria-label="Component source project" value={sourceDesignId} disabled={sourceLoading || sourceDesigns.length === 0} onChange={(event) => {
          setSourceDesignId(event.target.value);
          setSourceRevisionId("");
          setSourceInspect(null);
          setDraft(null);
        }}>
          {sourceDesigns.length === 0 && <option value="">No projects</option>}
          {sourceDesigns.map((design) => <option key={design.id} value={design.id}>{design.name}</option>)}
        </select></label>
        <label>Revision<select aria-label="Component source revision" value={sourceRevisionId} disabled={sourceLoading || sourceRevisions.length === 0} onChange={(event) => {
          setSourceRevisionId(event.target.value);
          setSourceInspect(null);
          setDraft(null);
        }}>
          {sourceRevisions.length === 0 && <option value="">No revisions</option>}
          {sourceRevisions.map((revision) => <option key={revision.id} value={revision.id}>v{revision.version} · {revision.message}</option>)}
        </select></label>
        <div className={`component-source-status ${sourceReference && sourceNodes.length > 0 ? "is-ready" : "is-blocked"}`}>
          {sourceLoading ? <><LoaderCircle className="spin" size={14} /> Verifying revision…</>
            : sourceInspect?.document.schema_version !== 2 ? <><CircleAlert size={14} /> Select a strict V2 revision.</>
            : sourceNodes.length === 0 ? <><CircleAlert size={14} /> This revision has no visible container roots.</>
            : <><Check size={14} /> {sourceNodes.length} eligible container root{sourceNodes.length === 1 ? "" : "s"} · snapshot {sourceInspect.revision.snapshotHash.slice(0, 12)}</>}
        </div>
      </div>}

      {designSystems.length === 0 ? (
        <div className="administration-empty"><Boxes size={24} /><strong>Create a design system first</strong><span>Component definitions belong to an organization design system.</span></div>
      ) : <div className={`component-authoring-workspace ${canAuthorComponents && draft ? "has-editor" : ""}`}>
        <div className="component-catalog">
          {loading ? <div className="administration-empty"><LoaderCircle className="spin" size={20} /> Loading component definitions…</div> : components.length === 0 ? (
            <div className="administration-empty"><Boxes size={24} /><strong>No component definitions yet</strong><span>{canAuthorComponents ? "Create a draft with typed properties, slots, states, and override rules." : "No component definitions are available in this design system."}</span></div>
          ) : components.map((component) => (
            <article className="component-catalog-row" key={component.componentId}>
              <div className="component-catalog-title">
                <div><strong>{component.definition.name}</strong><code>{component.definition.key}</code></div>
                <span className={`component-status is-${component.status}`}>{component.status}</span>
              </div>
              <small>v{component.version} · {component.versionCount} immutable version{component.versionCount === 1 ? "" : "s"} · {component.definition.properties_schema.length} properties · {component.definition.slots.length} slots · {component.definition.states.length} states</small>
              <small>{component.source.kind === "verified" ? `Verified source · ${component.source.nodeCount} nodes · ${component.source.hash.slice(0, 12)}` : "Legacy source unavailable · cannot publish"}</small>
              {component.replacement && <small className="component-replacement">Replacement: {component.replacement.name} v{component.replacement.version}</small>}
              {component.diagnostics.map((diagnostic) => <div className={`component-diagnostic is-${diagnostic.severity}`} key={diagnostic.code}><CircleAlert size={12} /><span>{diagnostic.message}</span></div>)}
              {canAuthorComponents && <div className="component-catalog-controls">
                {component.status !== "deprecated" && <button className="button button-secondary" disabled={busy !== null} onClick={() => setDraft(draftFromComponent(component))}>{component.status === "draft" ? "Revise draft" : "New draft"}</button>}
                {component.status === "draft" && <button className="button button-primary" disabled={busy !== null || !sourceReference} onClick={() => {
                  if (!window.confirm(`Publish ${component.definition.name} as immutable version ${component.version + 1}?`)) return;
                  void mutate(`publish-${component.componentId}`, async () => {
                    await transitionDesignSystemComponent({
                      designSystemId: selectedSystemId,
                      componentId: component.componentId,
                      expectedLatestVersion: component.version,
                      targetStatus: "published",
                      source: requireSourceReference(),
                    });
                    setDraft(null);
                    setNotice(`${component.definition.name} was published as version ${component.version + 1}.`);
                    await refresh();
                  });
                }}>{busy === `publish-${component.componentId}` ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />} Publish</button>}
                {component.status !== "deprecated" && <>
                  <select
                    aria-label={`Replacement for ${component.definition.name}`}
                    value={replacementByComponent[component.componentId] ?? ""}
                    onChange={(event) => setReplacementByComponent((current) => ({ ...current, [component.componentId]: event.target.value }))}
                  >
                    <option value="">No replacement</option>
                    {publishedReplacements.filter((candidate) => candidate.componentId !== component.componentId).map((candidate) => (
                      <option key={candidate.componentId} value={candidate.componentId}>{candidate.definition.name}</option>
                    ))}
                  </select>
                  <button className="button button-secondary is-danger" disabled={busy !== null || !sourceReference} onClick={() => {
                    if (!window.confirm(`Deprecate ${component.definition.name} by creating immutable version ${component.version + 1}?`)) return;
                    void mutate(`deprecate-${component.componentId}`, async () => {
                      await transitionDesignSystemComponent({
                        designSystemId: selectedSystemId,
                        componentId: component.componentId,
                        expectedLatestVersion: component.version,
                        targetStatus: "deprecated",
                        replacementComponentId: replacementByComponent[component.componentId] || null,
                        source: requireSourceReference(),
                      });
                      setDraft(null);
                      setNotice(`${component.definition.name} was deprecated as version ${component.version + 1}.`);
                      await refresh();
                    });
                  }}><Trash2 size={13} /> Deprecate</button>
                </>}
              </div>}
            </article>
          ))}
        </div>

        {canAuthorComponents && draft && <form className="component-contract-editor" onSubmit={(event) => {
          event.preventDefault();
          void mutate("save-component-draft", async () => {
            const definition = buildComponentDraftDefinition(draft);
            const created = await createDesignSystemComponentDraft({
              designSystemId: selectedSystemId,
              expectedLatestVersion: draft.expectedLatestVersion,
              definition,
              source: requireSourceReference(),
            });
            setDraft(null);
            setNotice(`${created.definition.name} draft v${created.version} was saved without changing prior versions.`);
            await refresh();
          });
        }}>
          <header><div><strong>{draft.expectedLatestVersion === 0 ? "New component draft" : `Draft from v${draft.expectedLatestVersion}`}</strong><small>Saving creates version {draft.expectedLatestVersion + 1}; it never edits an existing row.</small></div><button type="button" className="icon-button" aria-label="Close component editor" onClick={() => setDraft(null)}>×</button></header>
          <div className="component-contract-fields">
            <label>Name<input required maxLength={240} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>Stable key<input required maxLength={200} value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} /></label>
            <label className="wide">Default state root<select required aria-label="Component default state root" value={draft.rootNodeId} onChange={(event) => {
              const previousRoot = draft.rootNodeId;
              setDraft({
                ...draft,
                rootNodeId: event.target.value,
                states: draft.states.map((state) => state.key === "default" && state.nodeId === previousRoot
                  ? { ...state, nodeId: event.target.value }
                  : state),
              });
            }}>
              <option value="">Choose a real container node</option>
              {sourceNodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.id}</option>)}
            </select></label>
            <label className="wide">Documentation summary<textarea maxLength={10_000} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
          </div>

          <section className="component-contract-section">
            <div><strong>Typed properties</strong><button type="button" className="button button-secondary" onClick={() => setDraft({ ...draft, properties: [...draft.properties, { ...propertyDraft(), key: `property${draft.properties.length + 1}`, label: `Property ${draft.properties.length + 1}` }] })}><Plus size={12} /> Property</button></div>
            {draft.properties.map((property, index) => <div className="component-contract-row property-row" key={index}>
              <input aria-label={`Property ${index + 1} key`} required value={property.key} onChange={(event) => updateProperty(index, { key: event.target.value })} />
              <input aria-label={`Property ${index + 1} label`} required value={property.label} onChange={(event) => updateProperty(index, { label: event.target.value })} />
              <select aria-label={`Property ${index + 1} type`} value={property.type} onChange={(event) => updateProperty(index, { type: event.target.value as PropertyType })}>{PROPERTY_TYPES.map((type) => <option key={type} value={type}>{type.replace("_", " ")}</option>)}</select>
              {property.type === "enum" ? <input aria-label={`Property ${index + 1} enum values`} required value={property.enumValues} onChange={(event) => updateProperty(index, { enumValues: event.target.value })} /> : property.type === "boolean" ? <select aria-label={`Property ${index + 1} default`} value={property.defaultValue} onChange={(event) => updateProperty(index, { defaultValue: event.target.value })}><option value="">No default</option><option value="true">True</option><option value="false">False</option></select> : property.type === "node_slot" ? <div className="component-number-pair"><input aria-label={`Property ${index + 1} minimum items`} type="number" min={0} max={100} value={property.minItems} onChange={(event) => updateProperty(index, { minItems: Number(event.target.value) })} /><input aria-label={`Property ${index + 1} maximum items`} type="number" min={1} max={100} value={property.maxItems} onChange={(event) => updateProperty(index, { maxItems: Number(event.target.value) })} /></div> : <input aria-label={`Property ${index + 1} default`} placeholder="Optional default" value={property.defaultValue} onChange={(event) => updateProperty(index, { defaultValue: event.target.value })} />}
              <label className="component-checkbox"><input type="checkbox" checked={property.required} onChange={(event) => updateProperty(index, { required: event.target.checked })} /> Required</label>
              <button type="button" className="icon-button is-danger" aria-label={`Remove property ${index + 1}`} onClick={() => setDraft({ ...draft, properties: draft.properties.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={12} /></button>
            </div>)}
          </section>

          <section className="component-contract-section">
            <div><strong>Slots</strong><button type="button" className="button button-secondary" onClick={() => setDraft({ ...draft, slots: [...draft.slots, { ...slotDraft(), key: `slot${draft.slots.length + 1}`, name: `Slot ${draft.slots.length + 1}` }] })}><Plus size={12} /> Slot</button></div>
            {draft.slots.length === 0 && <small>No content slots. Add one for bounded nested nodes.</small>}
            {draft.slots.map((slot, index) => <div className="component-contract-row slot-row" key={index}>
              <input aria-label={`Slot ${index + 1} key`} required value={slot.key} onChange={(event) => updateSlot(index, { key: event.target.value })} />
              <input aria-label={`Slot ${index + 1} name`} required value={slot.name} onChange={(event) => updateSlot(index, { name: event.target.value })} />
              <input aria-label={`Slot ${index + 1} allowed node types`} placeholder={NODE_TYPES.join(", ")} value={slot.allowedNodeTypes} onChange={(event) => updateSlot(index, { allowedNodeTypes: event.target.value })} />
              <div className="component-number-pair"><input aria-label={`Slot ${index + 1} minimum items`} type="number" min={0} max={100} value={slot.minItems} onChange={(event) => updateSlot(index, { minItems: Number(event.target.value) })} /><input aria-label={`Slot ${index + 1} maximum items`} type="number" min={1} max={100} value={slot.maxItems} onChange={(event) => updateSlot(index, { maxItems: Number(event.target.value) })} /></div>
              <label className="component-checkbox"><input type="checkbox" checked={slot.required} onChange={(event) => updateSlot(index, { required: event.target.checked })} /> Required</label>
              <button type="button" className="icon-button is-danger" aria-label={`Remove slot ${index + 1}`} onClick={() => setDraft({ ...draft, slots: draft.slots.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={12} /></button>
            </div>)}
          </section>

          <section className="component-contract-section">
            <div><strong>Visual states</strong><button type="button" className="button button-secondary" disabled={draft.states.length >= STATE_TYPES.length} onClick={() => {
              const key = STATE_TYPES.find((candidate) => !draft.states.some((state) => state.key === candidate));
              if (!key) return;
              const nodeId = sourceNodes.find((node) => !draft.states.some((state) => state.nodeId === node.id))?.id ?? "";
              setDraft({ ...draft, states: [...draft.states, { key, name: key[0]!.toUpperCase() + key.slice(1), nodeId }] });
            }}><Plus size={12} /> State</button></div>
            {draft.states.map((state, index) => <div className="component-contract-row state-row" key={index}>
              <select aria-label={`State ${index + 1} type`} value={state.key} disabled={state.key === "default"} onChange={(event) => updateState(index, { key: event.target.value as StateType })}>{STATE_TYPES.map((type) => <option key={type} value={type} disabled={draft.states.some((candidate, candidateIndex) => candidateIndex !== index && candidate.key === type)}>{type}</option>)}</select>
              <input aria-label={`State ${index + 1} name`} required value={state.name} onChange={(event) => updateState(index, { name: event.target.value })} />
              <select aria-label={`State ${index + 1} source root`} required value={state.nodeId} disabled={state.key === "default"} onChange={(event) => updateState(index, { nodeId: event.target.value })}>
                <option value="">Choose a real container node</option>
                {sourceNodes.map((node) => <option key={node.id} value={node.id} disabled={draft.states.some((candidate, candidateIndex) => candidateIndex !== index && candidate.nodeId === node.id)}>{node.name} · {node.id}</option>)}
              </select>
              {state.key !== "default" && <button type="button" className="icon-button is-danger" aria-label={`Remove state ${index + 1}`} onClick={() => setDraft({ ...draft, states: draft.states.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={12} /></button>}
            </div>)}
          </section>

          <section className="component-contract-section override-section">
            <div><strong>Allowed instance overrides</strong></div>
            <label className="component-checkbox"><input type="checkbox" checked={draft.allowText} onChange={(event) => setDraft({ ...draft, allowText: event.target.checked })} /> Text</label>
            <label className="component-checkbox"><input type="checkbox" checked={draft.allowAssets} onChange={(event) => setDraft({ ...draft, allowAssets: event.target.checked })} /> Assets</label>
            <label className="component-checkbox"><input type="checkbox" checked={draft.allowIcons} onChange={(event) => setDraft({ ...draft, allowIcons: event.target.checked })} /> Icons</label>
          </section>

          <footer><button type="button" className="button button-secondary" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={busy !== null || !sourceReference || draft.states.some((state) => !state.nodeId)}>{busy === "save-component-draft" ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Save immutable draft v{draft.expectedLatestVersion + 1}</button></footer>
        </form>}
      </div>}
    </section>
  );
}
