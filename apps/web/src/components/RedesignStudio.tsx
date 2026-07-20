import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
import {
  REDESIGN_STAGE_ORDER,
  readRedesignAssessment,
  reviseRedesignStage,
  transitionRedesignStage,
  type RedesignAssessmentRecord,
  type RedesignStage,
} from "../lib/api";

const stageLabels: Record<RedesignStage, { title: string; description: string }> = {
  connect_inspect: { title: "Connect & inspect", description: "Confirm the bounded source and current project context." },
  document_current_state: { title: "Current state", description: "Record screens, flows, roles, constraints, and observed issues." },
  pm_interview: { title: "PM interview", description: "Capture business intent, permissions, rules, and open questions." },
  future_state_proposal: { title: "Future state", description: "Review principles, target system, migration phases, and risks." },
  design: { title: "Design", description: "Create and review exact FormaSpec previews without source mutation." },
  handoff: { title: "Handoff", description: "Pin acceptance criteria and implementation slices to a revision." },
  approved_implementation: { title: "Approved implementation", description: "Implementation remains separately authorized and review-gated." },
};

function currentNotes(assessment: RedesignAssessmentRecord): string {
  const notes = assessment.current.content.notes;
  if (typeof notes === "string") return notes;
  return Object.keys(assessment.current.content).length > 0
    ? JSON.stringify(assessment.current.content, null, 2)
    : "";
}

export function RedesignStudio({ assessmentId }: { assessmentId: string }) {
  const [assessment, setAssessment] = useState<RedesignAssessmentRecord | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void readRedesignAssessment(assessmentId).then((record) => {
      if (!active) return;
      setAssessment(record);
      setNotes(currentNotes(record));
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "The redesign assessment could not be loaded.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [assessmentId]);

  const stageIndex = assessment ? REDESIGN_STAGE_ORDER.indexOf(assessment.currentStage) : 0;
  const expectedDesignVersion = assessment?.current.base.designVersion ?? undefined;
  const changed = assessment ? notes !== currentNotes(assessment) : false;
  const stage = assessment ? stageLabels[assessment.currentStage] : null;
  const sortedVersions = useMemo(() => [...(assessment?.versions ?? [])].reverse(), [assessment]);

  const run = async (key: string, action: () => Promise<RedesignAssessmentRecord>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      setAssessment(next);
      setNotes(currentNotes(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The redesign workflow action failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!assessment) return;
    void run("save", () => reviseRedesignStage({
      assessmentId: assessment.id,
      expectedVersion: assessment.currentVersion,
      ...(expectedDesignVersion ? { expectedDesignVersion } : {}),
      content: { notes },
    }));
  };

  const transition = (toStage: RedesignStage, decision: "advanced" | "returned" | "approved" | "cancelled" | "completed") => {
    if (!assessment) return;
    void run(decision, () => transitionRedesignStage({
      assessmentId: assessment.id,
      expectedVersion: assessment.currentVersion,
      ...(expectedDesignVersion ? { expectedDesignVersion } : {}),
      toStage,
      decision,
      content: { notes },
      details: { reviewedInWebsite: true, sourceMutation: "none" },
    }));
  };

  if (loading) return <main className="redesign-studio-shell"><div className="redesign-loading"><LoaderCircle className="spin" size={24} /> Loading the immutable assessment…</div></main>;
  if (!assessment || !stage) return <main className="redesign-studio-shell"><div className="redesign-loading"><XCircle size={24} />{error ?? "Assessment not found."}<button className="button button-secondary" onClick={() => navigate("/")}>Projects</button></div></main>;

  return (
    <main className="redesign-studio-shell">
      <header className="redesign-studio-header">
        <button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
        <div><span><Sparkles size={16} /></span><div><strong>Redesign Studio</strong><small>Assessment and approval workflow · no automatic source rewrite</small></div></div>
        {assessment.designId && <button className="button button-secondary" onClick={() => navigate(`/design/${encodeURIComponent(assessment.designId!)}`)}>Open design <ExternalLink size={13} /></button>}
      </header>

      <section className="redesign-studio-content">
        {error && <div className="administration-alert is-error"><XCircle size={16} /><span>{error}</span></div>}
        <div className="redesign-safety-banner"><ShieldCheck size={17} /><div><strong>Source mutation: none</strong><span>Advancing stages records immutable decisions only. Repository changes require a separate approved handoff and local Codex workspace authorization.</span></div></div>

        <nav className="redesign-stage-track" aria-label="Redesign stages">
          {REDESIGN_STAGE_ORDER.map((item, index) => (
            <div key={item} className={`${index < stageIndex ? "is-complete" : ""} ${index === stageIndex ? "is-current" : ""}`}>
              <span>{index < stageIndex ? <CheckCircle2 size={13} /> : index + 1}</span>
              <strong>{stageLabels[item].title}</strong>
            </div>
          ))}
        </nav>

        <div className="redesign-workspace-grid">
          <section className="redesign-stage-card">
            <header><div><span>{String(stageIndex + 1).padStart(2, "0")}</span><div><h1>{stage.title}</h1><p>{stage.description}</p></div></div><small>Assessment v{assessment.currentVersion} · {assessment.status}</small></header>
            <label>
              <span>Stage notes and reviewed evidence</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={assessment.status !== "active" || busy !== null} placeholder="Record the evidence, decisions, risks, and open questions for this stage…" />
            </label>
            <div className="redesign-stage-actions">
              <button className="button button-secondary" disabled={!changed || busy !== null || assessment.status !== "active"} onClick={save}>{busy === "save" ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />} Save stage</button>
              {stageIndex > 0 && assessment.status === "active" && <button className="button button-secondary" disabled={busy !== null} onClick={() => transition(REDESIGN_STAGE_ORDER[stageIndex - 1]!, "returned")}><RotateCcw size={13} /> Return</button>}
              {stageIndex < REDESIGN_STAGE_ORDER.length - 2 && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null} onClick={() => transition(REDESIGN_STAGE_ORDER[stageIndex + 1]!, "advanced")}>{busy === "advanced" ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />} Advance</button>}
              {assessment.currentStage === "handoff" && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null} onClick={() => transition("approved_implementation", "approved")}><ClipboardCheck size={13} /> Approve implementation stage</button>}
              {assessment.currentStage === "approved_implementation" && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null} onClick={() => transition("approved_implementation", "completed")}><CheckCircle2 size={13} /> Complete assessment</button>}
              {assessment.status === "active" && <button className="button button-danger" disabled={busy !== null} onClick={() => {
                if (window.confirm("Cancel this assessment? Immutable versions remain available.")) transition(assessment.currentStage, "cancelled");
              }}>Cancel</button>}
            </div>
          </section>

          <aside className="redesign-history-card">
            <header><strong>Immutable activity</strong><span>{assessment.versions.length} versions · {assessment.transitions.length} decisions</span></header>
            <div>
              {sortedVersions.map((version) => <article key={version.version}><span>v{version.version}</span><div><strong>{stageLabels[version.stage].title}</strong><small>{new Date(version.createdAt).toLocaleString()}</small></div></article>)}
            </div>
            <footer><code>{assessment.id}</code><small>Base design v{assessment.current.base.designVersion ?? "—"} · {assessment.current.base.revisionId ?? "inventory-only"}</small></footer>
          </aside>
        </div>
      </section>
    </main>
  );
}
