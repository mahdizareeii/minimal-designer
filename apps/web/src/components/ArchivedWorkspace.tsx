import {
  ArchiveRestore,
  ArrowLeft,
  CheckCircle2,
  FolderArchive,
  LoaderCircle,
  RefreshCcw,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { navigate } from "../App";
import { createClientKey, type DesignProjectSummary } from "../domain";
import {
  listDesigns,
  listProducts,
  restoreArchivedDesign,
  restoreProduct,
  type ProductSummary,
} from "../lib/api";

interface ArchivedProductGroup {
  product: ProductSummary;
  designs: DesignProjectSummary[];
}

export function ArchivedWorkspace() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [designs, setDesigns] = useState<DesignProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const restoreAttempts = useRef(new Map<string, string>());

  const restoreIdempotencyKey = (fingerprint: string, prefix: string) => {
    const existing = restoreAttempts.current.get(fingerprint);
    if (existing) return existing;
    const created = createClientKey(prefix);
    restoreAttempts.current.set(fingerprint, created);
    return created;
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allProducts, allDesigns] = await Promise.all([listProducts(true), listDesigns(true)]);
      setProducts(allProducts);
      setDesigns(allDesigns.filter((design) => design.status === "archived"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Archived Products and Designs could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const groups = useMemo(() => {
    const byProduct = new Map<string, DesignProjectSummary[]>();
    for (const design of designs) {
      if (!design.productId) continue;
      const current = byProduct.get(design.productId) ?? [];
      current.push(design);
      byProduct.set(design.productId, current);
    }
    const archivedProducts = products.filter((product) => product.status === "archived");
    const productIds = new Set([...archivedProducts.map((product) => product.id), ...byProduct.keys()]);
    return [...productIds].map((productId): ArchivedProductGroup | null => {
      const product = products.find((candidate) => candidate.id === productId);
      return product ? { product, designs: byProduct.get(productId) ?? [] } : null;
    }).filter((group): group is ArchivedProductGroup => group !== null);
  }, [designs, products]);

  const runRestore = async (key: string, operation: () => Promise<void>, message: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(message);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The archived item could not be restored.");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="archived-workspace-shell">
      <header className="archived-workspace-header">
        <button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
        <div><span><FolderArchive size={16} /></span><div><strong>Archived Products and Designs</strong><small>Archive is recoverable. Immutable revisions, tasks, specifications, and assets are retained.</small></div></div>
        <button className="icon-button" aria-label="Refresh archive" onClick={() => void refresh()} disabled={loading || busy !== null}><RefreshCcw size={15} className={loading ? "spin" : ""} /></button>
      </header>

      <section className="archived-workspace-content">
        <div className="archive-order-note"><ArchiveRestore size={17} /><div><strong>Restore order is protected</strong><span>Restore an archived Product first, then restore any Designs that belong to it.</span></div></div>
        {error && <div className="administration-alert is-error" role="alert">{error}</div>}
        {notice && <div className="administration-alert"><CheckCircle2 size={14} /> {notice}</div>}

        {loading ? <div className="activity-empty"><LoaderCircle size={22} className="spin" /> Loading archive…</div> : groups.length === 0 ? (
          <div className="activity-empty"><FolderArchive size={24} /><strong>Archive is empty</strong><span>Archived Products and Designs will appear here with restore controls.</span></div>
        ) : <div className="archived-product-list">
          {groups.map(({ product, designs: productDesigns }) => {
            const productArchived = product.status === "archived";
            return <section className={`archived-product-card ${productArchived ? "is-archived" : "is-active"}`} key={product.id}>
              <header>
                <div><span><FolderArchive size={15} /></span><div><h2>{product.name}</h2><p>{productArchived ? `Archived ${product.archivedAt ? new Date(product.archivedAt).toLocaleString() : ""}` : "Product is active; only selected Designs are archived."}</p></div></div>
                {productArchived && <button
                  className="button button-primary"
                  disabled={busy !== null}
                  onClick={() => void runRestore(
                    `product:${product.id}`,
                    async () => {
                      const fingerprint = `product:${product.id}:${product.updatedAt}:${product.archivedAt ?? ""}`;
                      await restoreProduct(product, restoreIdempotencyKey(fingerprint, "restore-product"));
                      restoreAttempts.current.delete(fingerprint);
                    },
                    `Restored Product ${product.name}. Its Designs can now be restored.`,
                  )}
                >{busy === `product:${product.id}` ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />} Restore Product</button>}
              </header>
              <div className="archived-design-list">
                {productDesigns.length === 0 ? <p className="archived-design-empty">No archived Designs are attached to this Product.</p> : productDesigns.map((design) => (
                  <article key={design.id}>
                    <div><strong>{design.name}</strong><span>Version {design.version} · Archived {design.archivedAt ? new Date(design.archivedAt).toLocaleString() : "recently"}</span></div>
                    <button
                      className="button button-secondary"
                      disabled={busy !== null || productArchived}
                      title={productArchived ? "Restore the Product first" : "Restore this Design"}
                      onClick={() => void runRestore(
                        `design:${design.id}`,
                        async () => {
                          const fingerprint = `design:${design.id}:${design.version}:${design.archivedAt ?? ""}`;
                          await restoreArchivedDesign(design, restoreIdempotencyKey(fingerprint, "restore-design"));
                          restoreAttempts.current.delete(fingerprint);
                        },
                        `Restored Design ${design.name}.`,
                      )}
                    >{busy === `design:${design.id}` ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />} {productArchived ? "Restore Product first" : "Restore Design"}</button>
                  </article>
                ))}
              </div>
            </section>;
          })}
        </div>}
      </section>
    </main>
  );
}
