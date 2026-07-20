import { PLANNING_SECTIONS } from "@designer/core";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  createPlanningSession,
  listPlanningSessions,
  savePlanningAnswer,
  transitionPlanningSession,
  type PlanningSessionRecord,
} from "../lib/api";

const sectionContent: Record<(typeof PLANNING_SECTIONS)[number], { title: string; prompt: string }> = {
  product_purpose: { title: "Product purpose", prompt: "What problem does this product solve, and what should be true when it succeeds?" },
  business_goals: { title: "Business goals", prompt: "Which measurable business outcomes matter most?" },
  user_groups_and_roles: { title: "User groups and roles", prompt: "Who uses the product, and which roles or authority levels exist?" },
  primary_user_jobs: { title: "Primary user jobs", prompt: "What are the most important jobs each user group needs to complete?" },
  important_flows: { title: "Important flows", prompt: "Describe the critical end-to-end flows and their desired outcomes." },
  target_platforms: { title: "Target platforms", prompt: "Which web, phone, tablet, or native platforms must be supported?" },
  brand_requirements: { title: "Existing brand requirements", prompt: "Which logos, colors, typefaces, imagery, or brand rules must be preserved?" },
  visual_personality: { title: "Desired visual personality", prompt: "How should the product feel: restrained, friendly, dense, premium, operational, or something else?" },
  languages_and_rtl: { title: "Languages and RTL", prompt: "Which locales, scripts, RTL behaviors, and mixed-direction cases are required?" },
  business_entities: { title: "Important business entities", prompt: "Which records and relationships define the product domain?" },
  permissions_and_sensitive_actions: { title: "Permissions and sensitive actions", prompt: "Who can view or change each resource, and which actions require confirmation or audit?" },
  validation_rules: { title: "Validation rules", prompt: "Which input, state, and cross-entity validation rules must the experience communicate?" },
  loading_states: { title: "Loading states", prompt: "Where can work take time, and what should users see while waiting?" },
  empty_states: { title: "Empty states", prompt: "Which empty conditions exist, and what useful next action should each offer?" },
  error_states: { title: "Error states", prompt: "Which failures are expected, and how can users understand or recover from them?" },
  permission_denied_states: { title: "Permission-denied states", prompt: "How should restricted access be explained without leaking sensitive information?" },
  accessibility_requirements: { title: "Accessibility requirements", prompt: "Which standards, assistive technologies, contrast, focus, keyboard, and touch requirements apply?" },
  analytics_and_success_metrics: { title: "Analytics and success metrics", prompt: "Which events and metrics show whether the product and its key flows are succeeding?" },
  technical_constraints: { title: "Technical constraints", prompt: "Which frameworks, performance budgets, security boundaries, integrations, or offline limits constrain the design?" },
  migration_constraints: { title: "Migration constraints", prompt: "What existing data, behavior, terminology, or rollout sequence must remain compatible?" },
  assumptions: { title: "Assumptions", prompt: "Which beliefs are currently unverified but are being used for planning?" },
  open_questions: { title: "Open questions", prompt: "Which decisions remain unresolved, who owns them, and when are answers needed?" },
};

export function PlanningInterview({ designId, open, onClose }: { designId: string; open: boolean; onClose: () => void }) {
  const [record, setRecord] = useState<PlanningSessionRecord | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void listPlanningSessions(designId).then((sessions) => {
      if (!active) return;
      const next = sessions.find((item) => !["completed", "cancelled"].includes(item.session.status)) ?? sessions[0] ?? null;
      setRecord(next);
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Could not load planning sessions.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [designId, open]);

  const currentSection = (record?.session.current_section ?? PLANNING_SECTIONS[0]) as (typeof PLANNING_SECTIONS)[number];
  const sectionIndex = PLANNING_SECTIONS.indexOf(currentSection);
  const latestAnswers = useMemo(() => {
    const bySection = new Map<string, PlanningSessionRecord["session"]["answers"][number]>();
    for (const item of record?.session.answers ?? []) {
      const current = bySection.get(item.section);
      if (!current || item.version > current.version) bySection.set(item.section, item);
    }
    return bySection;
  }, [record]);

  useEffect(() => {
    setAnswer(latestAnswers.get(currentSection)?.answer ?? "");
  }, [currentSection, latestAnswers]);

  if (!open) return null;

  const begin = async () => {
    setSaving(true);
    setError(null);
    try {
      setRecord(await createPlanningSession(designId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the planning session.");
    } finally {
      setSaving(false);
    }
  };

  const saveAndContinue = async () => {
    if (!record) return;
    setSaving(true);
    setError(null);
    try {
      const last = sectionIndex === PLANNING_SECTIONS.length - 1;
      const nextSection = last ? currentSection : PLANNING_SECTIONS[sectionIndex + 1]!;
      setRecord(await savePlanningAnswer({
        sessionId: record.session.id,
        expectedVersion: record.session.version,
        section: currentSection,
        answer,
        nextSection,
        status: last ? "ready_for_review" : "in_progress",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this planning answer.");
    } finally {
      setSaving(false);
    }
  };

  const editSection = async (section: (typeof PLANNING_SECTIONS)[number]) => {
    if (!record || section === currentSection || saving) return;
    setSaving(true);
    setError(null);
    try {
      setRecord(await transitionPlanningSession({
        sessionId: record.session.id,
        expectedVersion: record.session.version,
        status: "in_progress",
        currentSection: section,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reopen that planning section.");
    } finally {
      setSaving(false);
    }
  };

  const complete = async () => {
    if (!record) return;
    setSaving(true);
    setError(null);
    try {
      setRecord(await transitionPlanningSession({
        sessionId: record.session.id,
        expectedVersion: record.session.version,
        status: "completed",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete the planning session.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="planning-backdrop" role="presentation">
      <section className="planning-dialog" role="dialog" aria-modal="true" aria-labelledby="planning-title">
        <header>
          <div><span><ClipboardCheck size={17} /></span><div><h2 id="planning-title">Product-manager interview</h2><p>Persistent, resumable, editable, and versioned. One focused section at a time.</p></div></div>
          <button className="icon-button" onClick={onClose} aria-label="Close planning interview"><X size={16} /></button>
        </header>

        {loading ? <div className="planning-loading"><LoaderCircle size={23} className="spin" /> Loading planning session…</div> : !record ? (
          <div className="planning-welcome"><ClipboardCheck size={28} /><strong>Turn the brief into a reviewable product plan</strong><span>FormaSpec will guide you through all 22 required sections and preserve every answer version.</span><button className="button button-primary" disabled={saving} onClick={() => void begin()}>{saving ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />} Start interview</button>{error && <p>{error}</p>}</div>
        ) : (
          <div className="planning-body">
            <aside>
              <div className="planning-progress"><strong>{latestAnswers.size} / 22</strong><span>sections answered</span><i><b style={{ width: `${(latestAnswers.size / 22) * 100}%` }} /></i></div>
              <nav>{PLANNING_SECTIONS.map((section, index) => <button key={section} className={`${section === currentSection ? "is-active" : ""} ${latestAnswers.has(section) ? "is-complete" : ""}`} onClick={() => void editSection(section)}><span>{latestAnswers.has(section) ? <Check size={9} /> : index + 1}</span>{sectionContent[section].title}</button>)}</nav>
            </aside>
            <main>
              {record.session.status === "completed" ? <div className="planning-complete"><CheckCircle2 size={32} /><strong>Planning interview completed</strong><span>All answers remain editable only by creating a new session version or a new planning session.</span></div> : record.session.status === "ready_for_review" ? <div className="planning-review"><div><CheckCircle2 size={18} /><span><strong>Review all answers</strong><small>Every section has a persisted answer. Reopen any section or complete the session.</small></span></div><div className="planning-review-list">{PLANNING_SECTIONS.map((section) => <button key={section} onClick={() => void editSection(section)}><strong>{sectionContent[section].title}</strong><span>{latestAnswers.get(section)?.answer}</span></button>)}</div><button className="button button-primary" disabled={saving} onClick={() => void complete()}>{saving ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={13} />} Complete planning session</button></div> : <>
                <div className="planning-question-meta"><span>Section {sectionIndex + 1} of 22</span><span>Session v{record.session.version}</span></div>
                <h3>{sectionContent[currentSection].title}</h3>
                <p>{sectionContent[currentSection].prompt}</p>
                <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Write the product manager’s answer. This remains editable and versioned." autoFocus />
                {error && <div className="planning-error">{error}{error.includes("version") && <button onClick={() => window.location.reload()}><RotateCcw size={10} /> Reload</button>}</div>}
                <footer><button className="button button-secondary" disabled={saving || sectionIndex === 0} onClick={() => void editSection(PLANNING_SECTIONS[sectionIndex - 1]!)}><ArrowLeft size={12} /> Previous</button><button className="button button-primary" disabled={saving || !answer.trim()} onClick={() => void saveAndContinue()}>{saving ? <LoaderCircle size={13} className="spin" /> : sectionIndex === 21 ? <CheckCircle2 size={13} /> : <ArrowRight size={13} />}{sectionIndex === 21 ? "Review interview" : "Save and continue"}</button></footer>
              </>}
            </main>
          </div>
        )}
      </section>
    </div>
  );
}
