import { CopyPlus, Download, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";

import type { ConflictRecovery } from "../lib/conflict-recovery";

export function ConflictRecoveryPanel({
  recovery,
  durable,
  canLoadLatest,
  busy,
  onLoadLatest,
  onExportPatch,
  onDuplicate,
  onDiscard,
}: {
  recovery: ConflictRecovery;
  durable: boolean;
  canLoadLatest: boolean;
  busy: "load" | "export" | "duplicate" | "discard" | null;
  onLoadLatest: () => void;
  onExportPatch: () => void;
  onDuplicate: () => void;
  onDiscard: () => void;
}) {
  const latest = recovery.latestRevision;
  return (
    <section className="conflict-recovery-panel" aria-label="Conflict recovery" aria-live="polite">
      <div className="conflict-recovery-summary">
        <span><ShieldAlert size={15} /></span>
        <div>
          <strong>{durable ? "Local operations are protected" : "Protected in this tab only"}</strong>
          <small>
            Base v{recovery.baseRevision.version} · {recovery.operations.length} operation{recovery.operations.length === 1 ? "" : "s"} · <code>{recovery.operationHash.slice(0, 12)}</code>{durable ? "" : " · export now"}
          </small>
        </div>
      </div>
      <div className="conflict-recovery-latest">
        <strong>{latest?.version ? `Server v${latest.version}` : canLoadLatest ? "Newer server revision" : "Latest loaded"}</strong>
        <small>
          {[latest?.actor, latest?.createdAt].filter(Boolean).join(" · ") || "No automatic merge was performed"}
        </small>
      </div>
      <div className="conflict-recovery-actions">
        <button className="button button-secondary" disabled={busy !== null || !canLoadLatest} onClick={onLoadLatest}>
          <RefreshCw size={12} /> {busy === "load" ? "Loading…" : "Load latest"}
        </button>
        <button className="button button-secondary" disabled={busy !== null} onClick={onExportPatch}>
          <Download size={12} /> {busy === "export" ? "Exporting…" : "Export patch"}
        </button>
        <button className="button button-secondary" disabled={busy !== null} onClick={onDuplicate}>
          <CopyPlus size={12} /> {busy === "duplicate" ? "Duplicating…" : "Duplicate local draft"}
        </button>
        <button className="button button-danger" disabled={busy !== null} onClick={onDiscard}>
          <Trash2 size={12} /> {busy === "discard" ? "Discarding…" : "Discard recovery"}
        </button>
      </div>
    </section>
  );
}
