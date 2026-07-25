import {
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCcw,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
import {
  listOrganizationAgentTasks,
  listRedesignAssessments,
  type ActivityAgentTask,
  type ActivityRedesignAssessment,
  type AgentTaskStatus,
} from "../lib/api";

type ActivityFilter = "all" | "review" | "active" | "completed";

const statusPriority: Record<AgentTaskStatus, number> = {
  awaiting_approval: 0,
  in_progress: 1,
  claimed: 2,
  queued: 3,
  completed: 4,
  failed: 5,
  cancelled: 6,
  expired: 7,
};

function taskTimestamp(item: ActivityAgentTask): number {
  const value = item.task.transitions.at(-1)?.createdAt ?? item.task.createdAt;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Recently";
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "Just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function localPath(link: string | undefined, fallback: string): string {
  if (!link) return fallback;
  try {
    const parsed = new URL(link, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function taskMatches(filter: ActivityFilter, status: AgentTaskStatus): boolean {
  if (filter === "all") return true;
  if (filter === "review") return status === "awaiting_approval";
  if (filter === "active") return ["queued", "claimed", "in_progress"].includes(status);
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

export function ActivityInbox() {
  const [tasks, setTasks] = useState<ActivityAgentTask[]>([]);
  const [assessments, setAssessments] = useState<ActivityRedesignAssessment[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [taskResult, redesignResult] = await Promise.allSettled([
      listOrganizationAgentTasks(),
      listRedesignAssessments(),
    ]);
    if (taskResult.status === "fulfilled") setTasks(taskResult.value);
    else setTasks([]);
    if (redesignResult.status === "fulfilled") setAssessments(redesignResult.value);
    else setAssessments([]);
    if (taskResult.status === "rejected" && redesignResult.status === "rejected") {
      setError(taskResult.reason instanceof Error ? taskResult.reason.message : "Activity could not be loaded.");
    } else if (taskResult.status === "rejected") {
      setError("Agent tasks could not be loaded; Redesign Studio activity is still available.");
    } else if (redesignResult.status === "rejected") {
      setError("Redesign Studio activity could not be loaded; agent tasks are still available.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visibleTasks = useMemo(() => tasks
    .filter((item) => taskMatches(filter, item.task.status))
    .sort((left, right) => statusPriority[left.task.status] - statusPriority[right.task.status]
      || taskTimestamp(right) - taskTimestamp(left)), [filter, tasks]);
  const visibleAssessments = filter === "all"
    ? [...assessments].sort((left, right) => new Date(right.assessment.updatedAt).getTime() - new Date(left.assessment.updatedAt).getTime())
    : [];

  const copyLink = async (link: string, label: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setNotice(`Copied ${label}.`);
    } catch {
      setError(`The browser could not copy the ${label}. Open it and copy the address from the browser instead.`);
    }
  };

  return (
    <main className="activity-inbox-shell">
      <header className="activity-inbox-header">
        <button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button>
        <div><span><Sparkles size={16} /></span><div><strong>FormaSpec Activity</strong><small>Resume tasks, recover exact review links, and reopen redesign assessments.</small></div></div>
        <button className="icon-button" aria-label="Refresh activity" onClick={() => void refresh()} disabled={loading}><RefreshCcw size={15} className={loading ? "spin" : ""} /></button>
      </header>

      <section className="activity-inbox-content">
        {error && <div className="administration-alert is-error" role="alert">{error}</div>}
        {notice && <div className="administration-alert"><CheckCircle2 size={14} /> {notice}</div>}
        <div className="activity-inbox-heading">
          <div><h1>Continue where you left off</h1><p>These records live on the server, so links remain available after closing Codex or the browser.</p></div>
          <nav aria-label="Activity filters">
            {(["all", "review", "active", "completed"] as const).map((value) => (
              <button key={value} className={filter === value ? "is-active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {value === "all" ? "All" : value === "review" ? "Needs review" : value === "active" ? "In progress" : "Finished"}
              </button>
            ))}
          </nav>
        </div>

        {loading ? <div className="activity-empty"><LoaderCircle className="spin" size={22} /> Loading durable activity…</div> : (
          <div className="activity-list">
            {visibleTasks.map(({ task, design }) => {
              const designArchived = design.status === "archived";
              const updatedAt = task.transitions.at(-1)?.createdAt ?? task.createdAt;
              const reviewPath = localPath(task.reviewDeepLink ?? undefined, `/design/${encodeURIComponent(design.id)}?task=${encodeURIComponent(task.id)}`);
              const taskPath = localPath(task.websiteTaskLink, `/design/${encodeURIComponent(design.id)}?task=${encodeURIComponent(task.id)}`);
              const copyTarget = task.reviewDeepLink ?? task.websiteTaskLink ?? new URL(taskPath, window.location.origin).href;
              return <article className={`activity-card is-${task.status}`} key={task.id}>
                <span className="activity-card-icon"><Sparkles size={16} /></span>
                <div className="activity-card-main">
                  <div><strong>{design.name}</strong><span>{designArchived ? `archived Design · ${task.status.replaceAll("_", " ")}` : task.status.replaceAll("_", " ")}</span></div>
                  <p>{task.brief}</p>
                  <small><Clock3 size={11} /> {relativeTime(updatedAt)} · <code>{task.id}</code></small>
                </div>
                <div className="activity-card-actions">
                  {!designArchived && task.status === "awaiting_approval" && <button className="button button-primary" onClick={() => navigate(reviewPath)}><ExternalLink size={13} /> Review preview</button>}
                  {!designArchived && ["queued", "claimed", "in_progress"].includes(task.status) && <a className="button button-primary" href={task.launchUrl} rel="noopener noreferrer"><ExternalLink size={13} /> {task.status === "in_progress" ? "Resume regeneration" : "Open in Codex"}</a>}
                  {!designArchived && task.status === "completed" && <button className="button button-secondary" onClick={() => navigate(reviewPath)}><CheckCircle2 size={13} /> View result</button>}
                  <button className="button button-secondary" onClick={() => navigate(designArchived ? "/archived" : taskPath)}>{designArchived ? "Open archive" : "Open project"}</button>
                  <button className="icon-button" aria-label={`Copy link for task ${task.id}`} onClick={() => void copyLink(copyTarget, "task link")}><Clipboard size={13} /></button>
                </div>
              </article>;
            })}

            {visibleAssessments.map(({ assessment, design, websiteDeepLink }) => (
              <article className="activity-card is-redesign" key={assessment.id}>
                <span className="activity-card-icon"><WandSparkles size={16} /></span>
                <div className="activity-card-main">
                  <div><strong>{design?.name ?? "Repository redesign assessment"}</strong><span>{design?.status === "archived" ? `archived Design · ${assessment.currentStage.replaceAll("_", " ")}` : assessment.currentStage.replaceAll("_", " ")}</span></div>
                  <p>{assessment.current.brief}</p>
                  <small><Clock3 size={11} /> {relativeTime(assessment.updatedAt)} · <code>{assessment.id}</code></small>
                </div>
                <div className="activity-card-actions">
                  <button className="button button-primary" onClick={() => navigate(design?.status === "archived" ? "/archived" : localPath(websiteDeepLink, `/redesign/${encodeURIComponent(assessment.id)}`))}><ExternalLink size={13} /> {design?.status === "archived" ? "Open archive" : "Open redesign"}</button>
                  <button className="icon-button" aria-label={`Copy link for redesign ${assessment.id}`} onClick={() => void copyLink(websiteDeepLink, "redesign link")}><Clipboard size={13} /></button>
                </div>
              </article>
            ))}

            {visibleTasks.length === 0 && visibleAssessments.length === 0 && <div className="activity-empty"><Sparkles size={22} /><strong>No matching activity</strong><span>Submit a Product brief or start a Redesign assessment, then return here to resume it.</span></div>}
          </div>
        )}
      </section>
    </main>
  );
}
