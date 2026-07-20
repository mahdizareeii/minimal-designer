import { ClipboardCheck, Code2, LoaderCircle, RefreshCcw, Send, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  createEngineeringHandoff,
  listEngineeringHandoffs,
  listHistory,
  listRepositoryInventories,
  readRepositoryInventory,
  submitEngineeringHandoff,
  type EngineeringHandoffRecord,
  type RepositoryInventorySummary,
} from "../lib/api";

export function EngineeringHandoffPanel({
  designId,
  baseVersion,
  brief,
}: {
  designId: string;
  baseVersion: number;
  brief: string;
}) {
  const [handoffs, setHandoffs] = useState<EngineeringHandoffRecord[]>([]);
  const [inventories, setInventories] = useState<RepositoryInventorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextHandoffs, nextInventories] = await Promise.all([
        listEngineeringHandoffs(designId),
        listRepositoryInventories(),
      ]);
      setHandoffs(nextHandoffs);
      setInventories(nextInventories);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Engineering handoff context could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [designId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createDraft = async () => {
    const inventorySummary = inventories.find((inventory) => inventory.status === "active");
    if (!inventorySummary) {
      setError("Connect the local Workspace Bridge and upload a bounded repository inventory before creating a handoff.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const [inventory, history] = await Promise.all([
        readRepositoryInventory(inventorySummary.id),
        listHistory(designId),
      ]);
      const revision = history.find((item) => item.version === baseVersion);
      const firstEntity = inventory.inventory.entities[0];
      if (!revision) throw new Error(`Design version ${baseVersion} is not available in immutable history.`);
      if (!firstEntity) throw new Error("The active repository inventory has no source entities to map.");
      const normalizedBrief = brief.trim() || "Implement the approved FormaSpec revision.";
      const created = await createEngineeringHandoff({
        designId,
        revisionId: revision.id,
        expectedDesignVersion: baseVersion,
        inventoryId: inventory.id,
        specification: {
          schemaVersion: 1,
          title: "Implement approved FormaSpec revision",
          summary: normalizedBrief.slice(0, 4_000),
          acceptanceCriteria: [{
            id: "approved_revision_matches",
            statement: "The implementation matches the exact approved FormaSpec revision and its documented behavior.",
            designEntityIds: [],
          }],
          implementationSlices: [{
            id: "mapped_implementation",
            title: "Implement mapped product slice",
            objective: `Implement the approved revision beginning with ${firstEntity.name}, without unrelated source changes.`,
            inventoryEntityIds: [firstEntity.id],
            designEntityIds: [],
            dependsOn: [],
            validationChecks: ["typecheck", "unit_tests", "build"],
          }],
          risks: ["Repository inventory mappings must be reviewed before implementation."],
          openQuestions: [],
          implementationPolicy: {
            preferredIsolation: "worktree",
            commitRequiresExplicitApproval: true,
            pullRequestRequiresExplicitRequest: true,
          },
        },
      });
      setHandoffs((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff draft could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const submit = async (handoff: EngineeringHandoffRecord) => {
    setBusy(handoff.id);
    setError(null);
    try {
      const next = await submitEngineeringHandoff(handoff.id, handoff.currentVersion);
      setHandoffs((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff could not be submitted.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="product-panel-placeholder"><LoaderCircle className="spin" size={18} /><strong>Loading engineering handoffs</strong><span>Resolving the exact design revision and bounded repository inventory.</span></div>;

  return (
    <div className="engineering-handoff-panel">
      <header>
        <div><ClipboardCheck size={17} /><span><strong>Engineering handoff</strong><small>Revision-pinned plan with human review and explicit implementation approval.</small></span></div>
        <div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh handoffs"><RefreshCcw size={13} /></button><button className="button button-primary" disabled={busy !== null} onClick={() => void createDraft()}>{busy === "create" ? <LoaderCircle size={13} className="spin" /> : <Code2 size={13} />} Create draft</button></div>
      </header>
      {error && <div className="product-panel-error">{error}</div>}
      <div className="handoff-context-strip"><ShieldCheck size={13} /><span>Design v{baseVersion}</span><span>{inventories.filter((item) => item.status === "active").length} active repository inventory</span><span>No repository path or credential is stored centrally</span></div>
      <div className="handoff-list">
        {handoffs.length === 0 ? <div className="handoff-empty"><ClipboardCheck size={21} /><strong>No handoff for this project</strong><span>Create a draft only after the Workspace Bridge inventory is available. Source changes remain disabled.</span></div> : handoffs.map((handoff) => (
          <article key={handoff.id}>
            <span className={`handoff-status is-${handoff.status}`}>{handoff.status.replaceAll("_", " ")}</span>
            <div><strong>{String(handoff.specification.title ?? "Engineering handoff")}</strong><small>Design v{handoff.designVersion} · Handoff v{handoff.currentVersion} · {handoff.transitions.length} decisions</small><code>{handoff.id}</code></div>
            {handoff.status === "draft" && <button className="button button-secondary" disabled={busy !== null} onClick={() => void submit(handoff)}>{busy === handoff.id ? <LoaderCircle size={12} className="spin" /> : <Send size={12} />} Submit review</button>}
          </article>
        ))}
      </div>
    </div>
  );
}
