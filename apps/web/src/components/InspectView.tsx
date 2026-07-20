import {
  ArrowLeft,
  Box,
  Braces,
  CheckCircle2,
  Clock3,
  Code2,
  Component,
  Database,
  ExternalLink,
  FileCheck2,
  Hash,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  LoaderCircle,
  Palette,
  Ruler,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
import { readRevisionInspect, renderUrl, type RevisionInspectNode, type RevisionInspectResult } from "../lib/api";

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function valueLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "Unavailable";
  return JSON.stringify(value);
}

function recordLabel(value: Record<string, unknown>, key: string, fallback: string): string {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : fallback;
}

export function InspectView({ projectId, revisionId }: { projectId: string; revisionId: string }) {
  const [result, setResult] = useState<RevisionInspectResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    setError(null);
    void readRevisionInspect(projectId, revisionId).then((value) => {
      if (!active) return;
      setResult(value);
      setSelectedId(value.nodes.find((node) => !node.archived)?.id ?? value.nodes[0]?.id ?? null);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load the immutable revision.");
    });
    return () => { active = false; };
  }, [projectId, revisionId]);

  const nodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!result || !normalized) return result?.nodes ?? [];
    return result.nodes.filter((node) => `${node.name} ${node.type} ${node.id}`.toLocaleLowerCase().includes(normalized));
  }, [query, result]);
  const selected: RevisionInspectNode | undefined = result?.nodes.find((node) => node.id === selectedId);

  if (error) {
    return <main className="inspect-loading"><ShieldCheck size={28} /><strong>Revision inspect is unavailable</strong><span>{error}</span><button className="button button-secondary" onClick={() => navigate(`/design/${encodeURIComponent(projectId)}`)}><ArrowLeft size={14} /> Return to project</button></main>;
  }
  if (!result) return <main className="inspect-loading"><LoaderCircle className="spin" size={28} /><strong>Loading immutable revision…</strong></main>;

  return (
    <main className="inspect-shell">
      <header className="inspect-topbar">
        <div>
          <button className="icon-button" onClick={() => navigate(`/design/${encodeURIComponent(projectId)}`)} aria-label="Return to editor"><ArrowLeft size={16} /></button>
          <span className="inspect-product-mark"><ShieldCheck size={15} /></span>
          <div><strong>{result.project.name}</strong><small>Read-only engineering inspect · pinned revision {result.revision.version}</small></div>
        </div>
        <div className="inspect-integrity-pills">
          <span><CheckCircle2 size={11} /> Immutable</span>
          <span>Pinned v{result.revision.version}</span>
          {result.head.version !== result.revision.version && <span>Head v{result.head.version}</span>}
          <span>Schema v{result.integrity.schemaVersion}</span>
          <span>{result.nodes.length} nodes</span>
        </div>
      </header>

      <section className="inspect-main">
        <aside className="inspect-layers">
          <div className="inspect-section-heading"><Layers3 size={13} /><strong>Nodes</strong></div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, type, or name" aria-label="Search revision nodes" />
          <div className="inspect-node-list">
            {nodes.map((node) => <button key={node.id} className={selectedId === node.id ? "is-active" : ""} onClick={() => setSelectedId(node.id)}><span><Box size={11} /></span><div><strong>{node.name}</strong><small>{node.type} · {node.id}</small></div></button>)}
          </div>
        </aside>

        <section className="inspect-preview">
          <div className="inspect-preview-label"><FileCheck2 size={12} /><span>Exact Chromium render · design version {result.revision.version}</span></div>
          <div><img src={renderUrl(projectId, { version: result.revision.version, maxSize: 2600 })} alt={`Immutable render of ${result.project.name}`} /></div>
        </section>

        <aside className="inspect-details">
          <div className="inspect-section-heading"><Ruler size={13} /><strong>Engineering details</strong></div>
          {selected ? <>
            <section className="inspect-card">
              <h3>{selected.name}<span>{selected.type}</span></h3>
              <dl>
                <div><dt>X</dt><dd>{selected.boundingBox.x}</dd></div><div><dt>Y</dt><dd>{selected.boundingBox.y}</dd></div>
                <div><dt>W</dt><dd>{selected.boundingBox.width}</dd></div><div><dt>H</dt><dd>{selected.boundingBox.height}</dd></div>
                <div><dt>Rotation</dt><dd>{selected.boundingBox.rotation}°</dd></div><div><dt>Visible</dt><dd>{String(selected.visible)}</dd></div>
              </dl>
            </section>
            <section className="inspect-card"><h4><Braces size={11} /> Layout</h4><JsonBlock value={selected.layout} /></section>
            <section className="inspect-card"><h4><Braces size={11} /> Raw style and token references</h4><JsonBlock value={selected.style} /></section>
            <section className="inspect-card" data-testid="resolved-node-values"><h4><CheckCircle2 size={11} /> Resolved values</h4><JsonBlock value={selected.resolvedValues} /></section>
            {selected.tokenReferences.length > 0 && <section className="inspect-card"><h4><Palette size={11} /> Referenced tokens</h4><div className="inspect-evidence-list">
              {selected.tokenReferences.map((reference) => <article className="inspect-evidence-item" key={reference.jsonPath}>
                <strong>{reference.tokenPath ?? reference.tokenId}<span>{reference.status}</span></strong>
                <small>{valueLabel(reference.value)}</small><code>{reference.tokenId}</code><code>{reference.jsonPath}</code>
              </article>)}
            </div></section>}
            {selected.semantics && <section className="inspect-card"><h4><ScrollText size={11} /> Semantics and linked rules</h4><JsonBlock value={selected.semantics} /></section>}
            {Object.keys(selected.properties).length > 0 && <section className="inspect-card"><h4><Braces size={11} /> Typed properties</h4><JsonBlock value={selected.properties} /></section>}
            <section className="inspect-card"><h4><ExternalLink size={11} /> Stable identity</h4><code>{selected.id}</code><code>{selected.jsonPath}</code></section>
          </> : <div className="inspect-empty">Select a node to inspect exact measurements and values.</div>}

          <div className="inspect-evidence-heading"><ShieldCheck size={12} /><strong>Revision evidence</strong><span>exact snapshot</span></div>
          <section className="inspect-card" data-testid="revision-integrity">
            <h4><Hash size={11} /> Revision integrity</h4>
            <div className="inspect-integrity-list">
              <span><Clock3 size={10} /> {new Date(result.integrity.createdAt).toLocaleString()}</span>
              <code>{result.integrity.revisionId}</code>
              {result.integrity.parentRevisionId && <code>{result.integrity.parentRevisionId}</code>}
              <code>{result.integrity.revisionHash}</code>
              <code>{result.integrity.snapshotHash}</code>
              <code>{result.integrity.operationHash}</code>
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-tokens">
            <h4><Palette size={11} /> Tokens <span>{result.evidence.tokens.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.tokens.length === 0 && <p>None in this revision.</p>}
              {result.evidence.tokens.slice(0, 50).map((token) => <article className="inspect-evidence-item" key={token.id}>
                <strong>{token.path}<span>{token.family} · {token.layer}</span></strong>
                <small>Raw {valueLabel(token.rawValue)} · Resolved {valueLabel(token.resolvedValue)}</small>
                <code>{token.id}</code><code>{token.jsonPath}</code>
              </article>)}
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-assets">
            <h4><ImageIcon size={11} /> Assets <span>{result.evidence.assets.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.assets.length === 0 && <p>None in this revision.</p>}
              {result.evidence.assets.slice(0, 50).map((asset) => <article className="inspect-evidence-item" key={asset.id}>
                <strong>{asset.name}<span>{asset.status}</span></strong>
                <small>{asset.mimeType} · {asset.width ?? "?"}×{asset.height ?? "?"} · {asset.sizeBytes} bytes</small>
                <code>{asset.sha256 ?? "No content hash"}</code><code>{asset.id}</code><code>{asset.jsonPath}</code>
              </article>)}
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-components">
            <h4><Component size={11} /> Components <span>{result.evidence.components.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.components.length === 0 && <p>None in this revision.</p>}
              {result.evidence.components.slice(0, 50).map((component) => <article className="inspect-evidence-item" key={component.id}>
                <strong>{component.name}<span>v{component.version} · {component.status}</span></strong>
                <small>{component.key} · {component.instanceCount} instance{component.instanceCount === 1 ? "" : "s"}</small>
                <code>{component.id}</code>{component.rootNodeId && <code>{component.rootNodeId}</code>}<code>{component.jsonPath}</code>
              </article>)}
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-business-rules">
            <h4><ScrollText size={11} /> Business rules <span>{result.evidence.businessRules.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.businessRules.length === 0 && <p>No exact rule is pinned to this revision.</p>}
              {result.evidence.businessRules.slice(0, 50).map((rule) => <article className="inspect-evidence-item" key={String(rule.id)}>
                <strong>{recordLabel(rule, "title", String(rule.id))}<span>{recordLabel(rule, "priority", "rule")}</span></strong>
                <small>{recordLabel(rule, "description", "No description")}</small>
                <code>{String(rule.id)}</code><code>{rule.jsonPath}</code>
              </article>)}
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-acceptance-criteria">
            <h4><ListChecks size={11} /> Acceptance criteria <span>{result.evidence.acceptanceCriteria.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.acceptanceCriteria.length === 0 && <p>No exact criterion is pinned to this revision.</p>}
              {result.evidence.acceptanceCriteria.slice(0, 50).map((criterion) => <article className="inspect-evidence-item" key={String(criterion.id)}>
                <strong>{recordLabel(criterion, "title", String(criterion.id))}</strong>
                <small>{recordLabel(criterion, "description", valueLabel(criterion.then))}</small>
                <code>{String(criterion.id)}</code><code>{criterion.jsonPath}</code>
              </article>)}
            </div>
          </section>

          <section className="inspect-card" data-testid="inspect-implementation-mappings">
            <h4><Code2 size={11} /> Implementation mappings <span>{result.evidence.implementationMappings.length}</span></h4>
            <div className="inspect-evidence-list">
              {result.evidence.implementationMappings.length === 0 && <p>None pinned to this revision.</p>}
              {result.evidence.implementationMappings.slice(0, 50).map((mapping) => <article className="inspect-evidence-item" key={`${mapping.source}:${mapping.id}`}>
                <strong>{mapping.symbol}<span>{mapping.platform} · {mapping.targetType}</span></strong>
                <small>{mapping.sourceId} · {mapping.source}</small>
                <code>{mapping.id}</code><code>{mapping.jsonPath}</code>
              </article>)}
            </div>
          </section>
        </aside>
      </section>

      <footer className="inspect-footer">
        <div><Hash size={11} /><span>Revision</span><code title={result.integrity.revisionHash}>{shortHash(result.integrity.revisionHash)}</code></div>
        <div><Database size={11} /><span>Snapshot</span><code title={result.integrity.snapshotHash}>{shortHash(result.integrity.snapshotHash)}</code></div>
        <div><Braces size={11} /><span>Operations</span><code title={result.integrity.operationHash}>{shortHash(result.integrity.operationHash)}</code></div>
        <div><ExternalLink size={11} /><span>ID</span><code>{result.integrity.revisionId}</code></div>
        {result.limitations.map((limitation) => <span className="inspect-limitation" key={limitation}>{limitation}</span>)}
      </footer>
    </main>
  );
}
