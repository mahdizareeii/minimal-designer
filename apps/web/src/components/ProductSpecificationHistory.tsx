import { ArrowRight, Clock3, GitCompare, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  listProductSpecificationHistory,
  readProductSpecification,
  type ProductSpecificationHistoryItem,
  type ProductSpecificationRecord,
} from "../lib/api";

const comparedCollections = [
  ["roles", "Roles"],
  ["flows", "Flows"],
  ["business_rules", "Business rules"],
  ["permissions", "Permissions"],
  ["screen_states", "Screen states"],
  ["validations", "Validations"],
  ["acceptance_criteria", "Acceptance criteria"],
] as const;

export interface ProductSpecificationCollectionDiff {
  key: string;
  label: string;
  added: number;
  removed: number;
  changed: number;
  addedItems: string[];
  removedItems: string[];
  changedItems: string[];
}

interface ComparableSpecificationItem {
  value: unknown;
  label: string;
}

function comparableItemLabel(item: unknown, index: number): string {
  if (typeof item === "string" && item.trim()) return item.trim();
  const record = item && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  for (const key of ["title", "name", "label", "role", "state", "action", "description", "id"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return `Item ${index + 1}`;
}

function comparableItemMap(value: unknown): Map<string, ComparableSpecificationItem> {
  if (!Array.isArray(value)) return new Map();
  return new Map(value.map((item, index) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return [String(record.id ?? `index:${index}`), { value: item, label: comparableItemLabel(item, index) }] as const;
  }));
}

export function compareProductSpecifications(
  from: ProductSpecificationRecord | null,
  to: ProductSpecificationRecord | null,
): ProductSpecificationCollectionDiff[] {
  return comparedCollections.map(([key, label]) => {
    const before = comparableItemMap(from?.specification?.[key]);
    const after = comparableItemMap(to?.specification?.[key]);
    let added = 0;
    let removed = 0;
    let changed = 0;
    const addedItems: string[] = [];
    const removedItems: string[] = [];
    const changedItems: string[] = [];
    for (const [id, item] of after) {
      const previous = before.get(id);
      if (!previous) {
        added += 1;
        addedItems.push(item.label);
      } else if (JSON.stringify(previous.value) !== JSON.stringify(item.value)) {
        changed += 1;
        changedItems.push(item.label);
      }
    }
    for (const [id, item] of before) {
      if (after.has(id)) continue;
      removed += 1;
      removedItems.push(item.label);
    }
    return { key, label, added, removed, changed, addedItems, removedItems, changedItems };
  });
}

function DiffItemList({ label, items, className }: { label: string; items: string[]; className: string }) {
  if (items.length === 0) return null;
  const visible = items.slice(0, 8);
  return <div className={`product-history-change-items ${className}`}>
    <span>{label}</span>
    <ul>{visible.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul>
    {items.length > visible.length && <small>+{items.length - visible.length} more</small>}
  </div>;
}

export function ProductSpecificationHistory({
  designId,
  current,
  onEditAsNew,
}: {
  designId: string;
  current: ProductSpecificationRecord | null;
  onEditAsNew: (record: ProductSpecificationRecord, sourceVersion: number) => void;
}) {
  const [history, setHistory] = useState<ProductSpecificationHistoryItem[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(current?.version ?? null);
  const [compareVersion, setCompareVersion] = useState<number | null>(current && current.version > 1 ? current.version - 1 : null);
  const [selected, setSelected] = useState<ProductSpecificationRecord | null>(current);
  const [comparison, setComparison] = useState<ProductSpecificationRecord | null>(null);
  const [nextBeforeVersion, setNextBeforeVersion] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void listProductSpecificationHistory(designId).then((page) => {
      if (!active) return;
      setHistory(page.versions);
      setNextBeforeVersion(page.nextBeforeVersion);
      const nextSelected = current?.version ?? page.versions[0]?.version ?? null;
      setSelectedVersion(nextSelected);
      setCompareVersion(nextSelected && nextSelected > 1
        ? page.versions.find((item) => item.version < nextSelected)?.version ?? null
        : null);
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Product logic history could not be loaded.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [current?.version, designId]);

  useEffect(() => {
    let active = true;
    if (selectedVersion === null) {
      setSelected(null);
      return () => { active = false; };
    }
    if (current?.version === selectedVersion) {
      setSelected(current);
      return () => { active = false; };
    }
    void readProductSpecification(designId, selectedVersion).then((record) => {
      if (active) setSelected(record);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : `Version ${selectedVersion} could not be loaded.`);
    });
    return () => { active = false; };
  }, [current, designId, selectedVersion]);

  useEffect(() => {
    let active = true;
    if (compareVersion === null) {
      setComparison(null);
      return () => { active = false; };
    }
    if (current?.version === compareVersion) {
      setComparison(current);
      return () => { active = false; };
    }
    void readProductSpecification(designId, compareVersion).then((record) => {
      if (active) setComparison(record);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : `Version ${compareVersion} could not be loaded.`);
    });
    return () => { active = false; };
  }, [compareVersion, current, designId]);

  const diffs = useMemo(() => compareProductSpecifications(comparison, selected), [comparison, selected]);
  const selectedMeta = history.find((item) => item.version === selectedVersion) ?? null;

  const loadMore = async () => {
    if (nextBeforeVersion === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listProductSpecificationHistory(designId, 50, nextBeforeVersion);
      setHistory((currentHistory) => {
        const seen = new Set(currentHistory.map((item) => item.version));
        return [...currentHistory, ...page.versions.filter((item) => !seen.has(item.version))];
      });
      setNextBeforeVersion(page.nextBeforeVersion);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "More Product logic versions could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <div className="product-history-empty"><LoaderCircle size={18} className="spin" /> Loading immutable Product logic history…</div>;
  if (error && history.length === 0) return <div className="product-history-empty is-error">{error}</div>;
  if (history.length === 0) return <div className="product-history-empty"><Clock3 size={18} /><strong>No committed logic versions yet</strong><span>Save the Product brief to create version 1.</span></div>;

  return <div className="product-history-workspace">
    <aside aria-label="Product logic versions">
      <strong>Immutable versions</strong>
      <div>{history.map((item) => <button
          key={item.version}
          className={selectedVersion === item.version ? "is-active" : ""}
          onClick={() => setSelectedVersion(item.version)}
        >
          <span>v{item.version}</span>
          <small>{item.message}</small>
          <time>{item.createdAt ? new Date(item.createdAt).toLocaleString() : "Saved"}</time>
        </button>)}
        {nextBeforeVersion !== null && <button className="product-history-load-more" disabled={loadingMore} onClick={() => void loadMore()}>
          <span>{loadingMore ? <LoaderCircle size={12} className="spin" /> : <Clock3 size={12} />}</span><small>Load older versions</small>
        </button>}
      </div>
    </aside>

    <section className="product-history-detail">
      <header>
        <div><strong>Version {selectedVersion}</strong><span>{selectedMeta?.specificationHash.slice(0, 12) || selected?.specificationHash?.slice(0, 12)} · {selectedMeta?.actorId || "unknown actor"}</span></div>
        {selected && <button className="button button-primary" onClick={() => onEditAsNew(selected, selected.version)}><RotateCcw size={12} /> Edit v{selected.version} as new version</button>}
      </header>
      <div className="product-history-briefs">
        <article><span>Brief in v{selectedVersion}</span><p>{selected?.naturalLanguageBrief || "No natural-language brief."}</p></article>
        {comparison && <article><span>Compared with v{comparison.version}</span><p>{comparison.naturalLanguageBrief || "No natural-language brief."}</p></article>}
      </div>
      <div className="product-history-compare-heading">
        <div><GitCompare size={14} /><strong>Structured changes</strong></div>
        <label>Compare from <select value={compareVersion ?? ""} onChange={(event) => setCompareVersion(event.target.value ? Number(event.target.value) : null)}>
          <option value="">No comparison</option>
          {history.filter((item) => item.version !== selectedVersion).map((item) => <option value={item.version} key={item.version}>Version {item.version}</option>)}
        </select></label>
        <ArrowRight size={13} />
        <span>Version {selectedVersion}</span>
      </div>
      <div className="product-history-diff-grid">
        {diffs.map((diff) => <article key={diff.key} className={diff.added || diff.removed || diff.changed ? "has-changes" : ""}>
          <header>
            <strong>{diff.label}</strong>
            <span className="is-added">+{diff.added}</span>
            <span className="is-removed">−{diff.removed}</span>
            <span className="is-changed">~{diff.changed}</span>
          </header>
          {diff.added || diff.removed || diff.changed ? <div>
            <DiffItemList label="Added" items={diff.addedItems} className="is-added" />
            <DiffItemList label="Removed" items={diff.removedItems} className="is-removed" />
            <DiffItemList label="Changed" items={diff.changedItems} className="is-changed" />
          </div> : <small>No item changes</small>}
        </article>)}
      </div>
      {error && <p className="product-history-warning">{error}</p>}
    </section>
  </div>;
}
