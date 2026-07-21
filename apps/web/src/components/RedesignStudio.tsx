import {
  REDESIGN_ARTIFACT_COLLECTIONS,
  RedesignStageArtifactSchema,
  evaluateRedesignStageReadiness,
  redesignArtifactItems,
  type RedesignArtifactCollectionKey,
  type RedesignArtifactItem,
  type RedesignStageArtifact,
} from "@designer/core";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
import {
  REDESIGN_STAGE_ORDER,
  readRedesignAssessment,
  reviseRedesignStageArtifact,
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

const artifactCollectionLabels: Record<RedesignArtifactCollectionKey, { title: string; description: string }> = {
  inventory: { title: "Inventory", description: "Screens, routes, components, flows, and bounded source entities." },
  source_connections: { title: "Source connections", description: "Explicitly selected design or inventory inputs and their review state." },
  constraints: { title: "Constraints", description: "Business, technical, policy, localization, and delivery boundaries." },
  navigation: { title: "Navigation", description: "Current or proposed routes, transitions, entry points, and exits." },
  roles: { title: "Roles", description: "People, permissions, responsibilities, and role-specific journeys." },
  accessibility_findings: { title: "Accessibility", description: "Observed or proposed accessibility outcomes with evidence." },
  localization_findings: { title: "Localization & RTL", description: "Locale, direction, translation, formatting, and layout findings." },
  business_goals: { title: "Business goals", description: "Measurable outcomes and product-manager priorities." },
  business_rules: { title: "Business rules", description: "Decision logic, permissions, validations, and exceptional behavior." },
  decisions: { title: "Decisions", description: "Reviewed product decisions and their evidence." },
  open_questions: { title: "Open questions", description: "Unresolved questions with an owner and explicit status." },
  principles: { title: "Design principles", description: "Principles that guide the target experience and later reviews." },
  target_system: { title: "Target system", description: "Future information architecture, patterns, and system boundaries." },
  token_proposals: { title: "Token proposals", description: "Primitive, semantic, and component token changes across contexts." },
  component_consolidation: { title: "Component consolidation", description: "Components to retain, merge, replace, or deprecate." },
  screen_plans: { title: "Screen plans", description: "Planned screens, states, roles, flows, and platform variants." },
  migration_phases: { title: "Migration phases", description: "Sequenced delivery phases with dependencies and exit criteria." },
  engineering_epics: { title: "Engineering epics", description: "Bounded implementation outcomes and acceptance slices." },
  risks: { title: "Risks", description: "Likelihood, impact, mitigation, and review ownership." },
  review_findings: { title: "Design review", description: "Before/after findings, diagnostics, and required refinements." },
  acceptance_criteria: { title: "Acceptance criteria", description: "Revision-pinned observable outcomes for engineering review." },
  approved_scope: { title: "Approved scope", description: "The exact reviewed scope authorized for the implementation stage." },
  implementation_conditions: { title: "Implementation conditions", description: "Isolation, review, validation, commit, and PR conditions." },
  validation_evidence: { title: "Validation evidence", description: "Approved checks and evidence recorded without central source access." },
};

export function redesignTransitionAvailability(
  artifact: RedesignStageArtifact,
  decision: "advanced" | "approved" | "completed",
) {
  const requirement = decision === "advanced" ? "reviewed" : "approved";
  const readiness = evaluateRedesignStageReadiness(artifact, requirement);
  const missingOutcomeCount = readiness.diagnostics.filter((diagnostic) =>
    diagnostic.code === "REDESIGN_STAGE_OUTCOME_REQUIRED").length;
  const blockedItemCount = readiness.diagnostics.filter((diagnostic) =>
    diagnostic.code === "REDESIGN_STAGE_ITEM_BLOCKED").length;
  const pendingItemCount = readiness.diagnostics.filter((diagnostic) =>
    diagnostic.code === "REDESIGN_STAGE_ITEM_REVIEW_REQUIRED"
      || diagnostic.code === "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED").length;
  const reviewInstruction = requirement === "approved"
    ? "Set the saved stage artifact to Approved"
    : "Set the saved stage artifact to Reviewed or Approved";
  const outcomeInstruction = missingOutcomeCount > 0
    ? ` and record an explicit outcome in ${missingOutcomeCount} required ${missingOutcomeCount === 1 ? "collection" : "collections"}`
    : "";
  const itemInstruction = blockedItemCount > 0
    ? `; resolve ${blockedItemCount} blocked ${blockedItemCount === 1 ? "item" : "items"}`
    : pendingItemCount > 0
      ? `; ${requirement === "approved" ? "approve or resolve" : "review or resolve"} ${pendingItemCount} pending ${pendingItemCount === 1 ? "item" : "items"}`
      : "";
  return {
    available: readiness.ready,
    disabled: !readiness.ready,
    requirement,
    diagnostics: readiness.diagnostics,
    reason: readiness.ready
      ? null
      : `${reviewInstruction}${outcomeInstruction}${itemInstruction} before this ${decision} action.`,
  };
}

export function redesignArtifactSections(artifact: RedesignStageArtifact) {
  return REDESIGN_ARTIFACT_COLLECTIONS[artifact.stage].map((key) => ({
    key,
    ...artifactCollectionLabels[key],
    items: redesignArtifactItems(artifact, key),
  }));
}

export function RedesignArtifactOverview({ artifact }: { artifact: RedesignStageArtifact }) {
  return (
    <div className="redesign-artifact-overview" aria-label="Stage artifact overview">
      {redesignArtifactSections(artifact).map((section) => (
        <article key={section.key}>
          <header><strong>{section.title}</strong><span>{section.items.length}</span></header>
          <p>{section.description}</p>
          {section.items.length > 0
            ? <ul>{section.items.slice(0, 3).map((item) => <li key={item.id}>{item.title}</li>)}</ul>
            : <small>Not recorded yet</small>}
        </article>
      ))}
    </div>
  );
}

function cloneArtifact(assessment: RedesignAssessmentRecord): RedesignStageArtifact {
  return RedesignStageArtifactSchema.parse(assessment.current.artifact);
}

function newArtifactItem(): RedesignArtifactItem {
  return {
    id: `redesign_item_${crypto.randomUUID().replaceAll("-", "")}`,
    title: "New reviewed item",
    description: "",
    status: "draft",
    priority: "normal",
    evidence: [],
    linked_ids: [],
  };
}

export function RedesignStudio({ assessmentId }: { assessmentId: string }) {
  const [assessment, setAssessment] = useState<RedesignAssessmentRecord | null>(null);
  const [artifactDraft, setArtifactDraft] = useState<RedesignStageArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void readRedesignAssessment(assessmentId).then((record) => {
      if (!active) return;
      setAssessment(record);
      setArtifactDraft(cloneArtifact(record));
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
  const changed = assessment && artifactDraft
    ? JSON.stringify(artifactDraft) !== JSON.stringify(assessment.current.artifact)
    : false;
  const stage = assessment ? stageLabels[assessment.currentStage] : null;
  const sortedVersions = useMemo(() => [...(assessment?.versions ?? [])].reverse(), [assessment]);
  const artifactValidation = artifactDraft ? RedesignStageArtifactSchema.safeParse(artifactDraft) : null;
  const artifactSections = artifactDraft ? redesignArtifactSections(artifactDraft) : [];
  const forwardDecision = assessment?.currentStage === "handoff"
    ? "approved"
    : assessment?.currentStage === "approved_implementation"
      ? "completed"
      : "advanced";
  const transitionAvailability = artifactDraft
    ? redesignTransitionAvailability(artifactDraft, forwardDecision)
    : null;
  const transitionActionTitle = changed
    ? "Save or discard artifact edits first."
    : transitionAvailability?.reason ?? undefined;

  const run = async (key: string, action: () => Promise<RedesignAssessmentRecord>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      setAssessment(next);
      setArtifactDraft(cloneArtifact(next));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The redesign workflow action failed.");
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!assessment || !artifactDraft || !artifactValidation?.success) return;
    void run("save", () => reviseRedesignStageArtifact({
      assessmentId: assessment.id,
      expectedVersion: assessment.currentVersion,
      ...(expectedDesignVersion ? { expectedDesignVersion } : {}),
      stage: assessment.currentStage,
      artifact: artifactValidation.data,
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
      details: { reviewedInWebsite: true, sourceMutation: "none" },
    }));
  };

  const updateArtifact = (patch: Partial<Pick<RedesignStageArtifact, "summary" | "review_status">>) => {
    setArtifactDraft((current) => current ? { ...current, ...patch } as RedesignStageArtifact : current);
  };

  const updateCollection = (key: RedesignArtifactCollectionKey, items: RedesignArtifactItem[]) => {
    setArtifactDraft((current) => current ? { ...current, [key]: items } as RedesignStageArtifact : current);
  };

  const updateItem = (
    key: RedesignArtifactCollectionKey,
    itemId: string,
    patch: Partial<RedesignArtifactItem>,
  ) => {
    if (!artifactDraft) return;
    updateCollection(key, redesignArtifactItems(artifactDraft, key).map((item) =>
      item.id === itemId ? { ...item, ...patch } : item));
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
            {artifactDraft && <div className="redesign-artifact-editor">
              <div className="redesign-artifact-heading">
                <label>
                  <span>Reviewed stage summary</span>
                  <textarea
                    value={artifactDraft.summary}
                    onChange={(event) => updateArtifact({ summary: event.target.value })}
                    disabled={assessment.status !== "active" || busy !== null}
                    placeholder="Summarize the evidence, decision, and intended outcome for this stage…"
                  />
                </label>
                <label>
                  <span>Review state</span>
                  <select
                    value={artifactDraft.review_status}
                    onChange={(event) => updateArtifact({ review_status: event.target.value as RedesignStageArtifact["review_status"] })}
                    disabled={assessment.status !== "active" || busy !== null}
                  >
                    <option value="draft">Draft</option>
                    <option value="ready_for_review">Ready for review</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="approved">Approved</option>
                  </select>
                </label>
              </div>

              <RedesignArtifactOverview artifact={artifactDraft} />

              <div className="redesign-artifact-collections">
                {artifactSections.map((section) => <section key={section.key}>
                  <header>
                    <div><strong>{section.title}</strong><small>{section.description}</small></div>
                    <button
                      type="button"
                      disabled={assessment.status !== "active" || busy !== null}
                      onClick={() => updateCollection(section.key, [...section.items, newArtifactItem()])}
                    ><Plus size={12} /> Add</button>
                  </header>
                  {section.items.length === 0
                    ? <div className="redesign-artifact-empty">Record an explicit outcome, including “no issue found,” before marking this stage ready.</div>
                    : <div className="redesign-artifact-items">{section.items.map((item) => <article key={item.id}>
                      <div className="redesign-artifact-item-main">
                        <input
                          aria-label={`${section.title} item title`}
                          value={item.title}
                          maxLength={240}
                          disabled={assessment.status !== "active" || busy !== null}
                          onChange={(event) => updateItem(section.key, item.id, { title: event.target.value })}
                        />
                        <textarea
                          aria-label={`${section.title} item description`}
                          value={item.description}
                          maxLength={8_000}
                          disabled={assessment.status !== "active" || busy !== null}
                          onChange={(event) => updateItem(section.key, item.id, { description: event.target.value })}
                          placeholder="Evidence, rationale, impact, or expected outcome…"
                        />
                      </div>
                      <div className="redesign-artifact-item-controls">
                        <select
                          aria-label={`${section.title} item status`}
                          value={item.status}
                          disabled={assessment.status !== "active" || busy !== null}
                          onChange={(event) => updateItem(section.key, item.id, { status: event.target.value as RedesignArtifactItem["status"] })}
                        >
                          <option value="draft">Draft</option>
                          <option value="ready">Ready</option>
                          <option value="reviewed">Reviewed</option>
                          <option value="approved">Approved</option>
                          <option value="blocked">Blocked</option>
                          <option value="resolved">Resolved</option>
                        </select>
                        <select
                          aria-label={`${section.title} item priority`}
                          value={item.priority}
                          disabled={assessment.status !== "active" || busy !== null}
                          onChange={(event) => updateItem(section.key, item.id, { priority: event.target.value as RedesignArtifactItem["priority"] })}
                        >
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                        <button
                          type="button"
                          aria-label={`Remove ${item.title}`}
                          disabled={assessment.status !== "active" || busy !== null}
                          onClick={() => updateCollection(section.key, section.items.filter((candidate) => candidate.id !== item.id))}
                        ><Trash2 size={12} /></button>
                      </div>
                    </article>)}</div>}
                </section>)}
              </div>

              {artifactValidation && !artifactValidation.success && <div className="redesign-artifact-validation">
                <XCircle size={14} />
                <span>{artifactValidation.error.issues[0]?.message ?? "The stage artifact is invalid."}</span>
              </div>}
              {assessment.status === "active" && transitionAvailability?.disabled && <div className="redesign-transition-gate" role="status">
                <ShieldCheck size={14} />
                <div><strong>Transition unavailable</strong><span>{transitionAvailability.reason}</span></div>
              </div>}
              {Object.keys(assessment.current.content).length > 0 && <details className="redesign-legacy-content">
                <summary>Legacy stage content</summary>
                <pre>{JSON.stringify(assessment.current.content, null, 2)}</pre>
              </details>}
            </div>}
            <div className="redesign-stage-actions">
              {changed && <button className="button button-secondary" disabled={busy !== null} onClick={() => setArtifactDraft(cloneArtifact(assessment))}><RotateCcw size={13} /> Discard edits</button>}
              <button className="button button-secondary" disabled={!changed || busy !== null || assessment.status !== "active" || !artifactValidation?.success} onClick={save}>{busy === "save" ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />} Save artifact</button>
              {stageIndex > 0 && assessment.status === "active" && <button className="button button-secondary" disabled={busy !== null || changed} title={changed ? "Save or discard artifact edits first." : undefined} onClick={() => transition(REDESIGN_STAGE_ORDER[stageIndex - 1]!, "returned")}><RotateCcw size={13} /> Return</button>}
              {stageIndex < REDESIGN_STAGE_ORDER.length - 2 && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null || changed || transitionAvailability?.disabled !== false} title={transitionActionTitle} onClick={() => transition(REDESIGN_STAGE_ORDER[stageIndex + 1]!, "advanced")}>{busy === "advanced" ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />} Advance</button>}
              {assessment.currentStage === "handoff" && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null || changed || transitionAvailability?.disabled !== false} title={transitionActionTitle} onClick={() => transition("approved_implementation", "approved")}><ClipboardCheck size={13} /> Approve implementation stage</button>}
              {assessment.currentStage === "approved_implementation" && assessment.status === "active" && <button className="button button-primary" disabled={busy !== null || changed || transitionAvailability?.disabled !== false} title={transitionActionTitle} onClick={() => transition("approved_implementation", "completed")}><CheckCircle2 size={13} /> Complete assessment</button>}
              {assessment.status === "active" && <button className="button button-danger" disabled={busy !== null} onClick={() => {
                if (window.confirm("Cancel this assessment? Immutable versions remain available.")) transition(assessment.currentStage, "cancelled");
              }}>Cancel</button>}
            </div>
          </section>

          <aside className="redesign-history-card">
            <header><strong>Immutable activity</strong><span>{assessment.versions.length} versions · {assessment.transitions.length} decisions</span></header>
            <div>
              {sortedVersions.map((version) => <article key={version.version}><span>v{version.version}</span><div><strong>{stageLabels[version.stage].title}</strong><small>{version.artifact.review_status.replaceAll("_", " ")} · {new Date(version.createdAt).toLocaleString()}</small></div></article>)}
            </div>
            <footer><code>{assessment.id}</code><small>Base design v{assessment.current.base.designVersion ?? "—"} · {assessment.current.base.revisionId ?? "inventory-only"}</small></footer>
          </aside>
        </div>
      </section>
    </main>
  );
}
