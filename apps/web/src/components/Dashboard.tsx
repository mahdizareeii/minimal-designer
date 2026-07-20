import {
  ArrowRight,
  Bot,
  Check,
  Clock3,
  CloudOff,
  Code2,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  Settings,
  Server,
  Smartphone,
  Sparkles,
  Tablet,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { navigate } from "../App";
import { DEVICE_PRESETS, type DevicePreset } from "../domain";
import { createRedesignAssessment, renderUrl } from "../lib/api";
import { useDesignerStore } from "../store/designer-store";

const presetIcons = {
  web: Monitor,
  phone: Smartphone,
  tablet: Tablet,
} as const;

function relativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Recently";
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

export function Dashboard() {
  const projects = useDesignerStore((state) => state.projects);
  const loading = useDesignerStore((state) => state.dashboardLoading);
  const creating = useDesignerStore((state) => state.creating);
  const offline = useDesignerStore((state) => state.offline);
  const error = useDesignerStore((state) => state.error);
  const loadProjects = useDesignerStore((state) => state.loadProjects);
  const createProject = useDesignerStore((state) => state.createProject);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [redesignOpen, setRedesignOpen] = useState(false);
  const [redesigning, setRedesigning] = useState<string | null>(null);
  const [redesignError, setRedesignError] = useState<string | null>(null);
  const [name, setName] = useState("Untitled product flow");
  const [preset, setPreset] = useState<DevicePreset>("web");
  const searchRef = useRef<HTMLInputElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? projects.filter((project) => project.name.toLocaleLowerCase().includes(needle)) : projects;
  }, [projects, query]);

  const submit = async () => {
    const cleanName = name.trim() || "Untitled design";
    try {
      const id = await createProject(cleanName, preset);
      setModalOpen(false);
      navigate(`/design/${encodeURIComponent(id)}`);
    } catch {
      // The store surfaces the domain/network error in the modal and dashboard.
    }
  };

  const startRedesign = async (project: (typeof projects)[number]) => {
    setRedesigning(project.id);
    setRedesignError(null);
    try {
      const assessment = await createRedesignAssessment({
        designId: project.id,
        expectedDesignVersion: project.version,
        brief: `Assess ${project.name}, document the current state, interview the product manager, and propose a reviewed future state before any implementation work.`,
      });
      setRedesignOpen(false);
      navigate(`/redesign/${encodeURIComponent(assessment.id)}`);
    } catch (cause) {
      setRedesignError(cause instanceof Error ? cause.message : "The redesign assessment could not be created.");
    } finally {
      setRedesigning(null);
    }
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate("/"); }}>
          <span className="brand-mark"><Sparkles size={16} strokeWidth={2.4} /></span>
          <span>FormaSpec</span>
          <span className="brand-badge">Self-hosted</span>
        </a>
        <div className="dashboard-header-actions">
          <div className={`connection-pill ${offline ? "is-offline" : ""}`}>
            {offline ? <CloudOff size={14} /> : <Server size={14} />}
            {offline ? "Server unavailable" : "Self-hosted"}
          </div>
          <button className="icon-button" aria-label="Open administration" title="Administration" onClick={() => navigate("/administration")}><Settings size={15} /></button>
          <button className="avatar-button" aria-label="Workspace account">MZ</button>
        </div>
      </header>

      <section className="dashboard-main">
        <div className="hero-row">
          <div>
            <div className="eyebrow"><Bot size={14} /> AI-first product design and specification</div>
            <h1>Describe the product.<br /><span>FormaSpec structures the work.</span></h1>
            <p>Design screens, document business logic, manage a shared design system, and hand one immutable specification to Codex or another connected agent.</p>
          </div>
          <div className="primary-action-grid" aria-label="Start a FormaSpec workflow">
            <button className="primary-action-card is-primary" onClick={() => setModalOpen(true)}>
              <Plus size={20} /><span><strong>Design a new product</strong><small>Start from a structured web, phone, or tablet frame.</small></span><ArrowRight size={16} />
            </button>
            <button className="primary-action-card" onClick={() => setRedesignOpen(true)}>
              <WandSparkles size={20} /><span><strong>Redesign an existing product</strong><small>Assess first; source changes always require approval.</small></span><ArrowRight size={16} />
            </button>
            <button className="primary-action-card" onClick={() => {
              projectsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              window.setTimeout(() => searchRef.current?.focus(), 350);
            }}>
              <FolderOpen size={20} /><span><strong>Open an existing FormaSpec project</strong><small>Continue from an immutable versioned project.</small></span><ArrowRight size={16} />
            </button>
          </div>
        </div>

        <div className="workflow-strip" aria-label="Workflow">
          <div><span>01</span><Bot size={18} /><strong>Describe</strong><small>Tell Codex what the product needs</small></div>
          <ArrowRight className="workflow-arrow" size={18} />
          <div><span>02</span><LayoutDashboard size={18} /><strong>Review</strong><small>Inspect and refine the live canvas</small></div>
          <ArrowRight className="workflow-arrow" size={18} />
          <div><span>03</span><Code2 size={18} /><strong>Handoff</strong><small>Export versioned JSON to build from</small></div>
        </div>

        <div className="projects-toolbar" ref={projectsRef}>
          <div>
            <h2>Recent designs</h2>
            <span>{projects.length} {projects.length === 1 ? "project" : "projects"}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search FormaSpec projects" />
            {query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
          </label>
        </div>

        {loading ? (
          <div className="project-grid" aria-label="Loading projects">
            {[0, 1, 2].map((item) => <div className="project-card project-skeleton" key={item} />)}
          </div>
        ) : filtered.length > 0 ? (
          <div className="project-grid">
            {filtered.map((project, index) => (
              <button
                className="project-card"
                key={project.id}
                onClick={() => navigate(`/design/${encodeURIComponent(project.id)}`)}
              >
                <div className={`project-thumbnail thumbnail-${index % 4}`}>
                  {!offline && (
                    <img
                      src={project.thumbnailUrl ?? renderUrl(project.id, { maxSize: 520 })}
                      alt=""
                      onError={(event) => { event.currentTarget.style.display = "none"; }}
                    />
                  )}
                  <div className="thumbnail-wireframe" aria-hidden="true">
                    <i /><i /><i /><b /><b />
                  </div>
                  <span className="project-version">v{project.version}</span>
                </div>
                <div className="project-card-meta">
                  <div><strong>{project.name}</strong><small><Clock3 size={12} /> Updated {relativeTime(project.updatedAt)}</small></div>
                  <span className="open-project"><ArrowRight size={16} /></span>
                </div>
              </button>
            ))}
            <button className="project-card new-project-card" onClick={() => setModalOpen(true)}>
              <span><Plus size={22} /></span>
              <strong>Create a new design</strong>
              <small>Start with a responsive frame</small>
            </button>
          </div>
        ) : offline ? (
          <div className="empty-projects">
            <div className="empty-orbit" style={{ color: "#efb664", borderColor: "#5a462b" }}><CloudOff size={24} /></div>
            <h3>Connect the self-hosted design server</h3>
            <p>{error ?? "Start the API on port 4310, then reload this workspace."}</p>
            <button className="button button-secondary" onClick={() => void loadProjects()}><Server size={15} /> Retry connection</button>
          </div>
        ) : (
          <div className="empty-projects">
            <div className="empty-orbit"><Sparkles size={24} /></div>
            <h3>{query ? "No designs match that search" : "Your first canvas is waiting"}</h3>
            <p>{query ? "Try another project name." : "Choose a frame and let Codex or your team shape the first screen."}</p>
            {!query && <button className="button button-primary" onClick={() => setModalOpen(true)}><Plus size={16} /> Create design</button>}
          </div>
        )}
      </section>

      <footer className="dashboard-footer">
        <span><Check size={13} /> Your design data stays on your server</span>
        <span>FormaSpec 0.2 · Minimal UI agent alias</span>
      </footer>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setModalOpen(false); }}>
          <div className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="modal-heading">
              <div><span className="modal-icon"><Plus size={18} /></span><div><h2 id="create-title">New design</h2><p>Start with a frame sized for your product.</p></div></div>
              <button className="icon-button" onClick={() => setModalOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <label className="field-label">Design name
              <input className="text-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
            </label>
            <div className="field-label">Starting frame</div>
            <div className="preset-grid">
              {(Object.keys(DEVICE_PRESETS) as DevicePreset[]).map((key) => {
                const Icon = presetIcons[key];
                const item = DEVICE_PRESETS[key];
                return (
                  <button className={`preset-option ${preset === key ? "is-selected" : ""}`} key={key} onClick={() => setPreset(key)}>
                    <span><Icon size={21} /></span>
                    <strong>{item.label}</strong>
                    <small>{item.width} × {item.height}</small>
                    {preset === key && <i><Check size={12} /></i>}
                  </button>
                );
              })}
            </div>
            <div className="modal-note"><Sparkles size={14} /> You can add more web, phone, or tablet frames any time.</div>
            {error && <div className="modal-note" style={{ color: "#ef9aa6" }}><CloudOff size={14} /> {error}</div>}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="button button-primary" disabled={creating} onClick={() => void submit()}>{creating ? "Creating…" : "Create design"}<ArrowRight size={16} /></button>
            </div>
          </div>
        </div>
      )}

      {redesignOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setRedesignOpen(false); }}>
          <div className="create-modal" role="dialog" aria-modal="true" aria-labelledby="redesign-title">
            <div className="modal-heading">
              <div><span className="modal-icon"><WandSparkles size={18} /></span><div><h2 id="redesign-title">Redesign an existing product</h2><p>Select a project to begin assessment and planning. This does not modify source code.</p></div></div>
              <button className="icon-button" onClick={() => setRedesignOpen(false)} aria-label="Close"><X size={18} /></button>
            </div>
            {projects.length > 0 ? (
              <div className="redesign-project-list">
                {projects.map((project) => (
                  <button key={project.id} disabled={redesigning !== null} onClick={() => void startRedesign(project)}>
                    {redesigning === project.id ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}<span><strong>{project.name}</strong><small>Version {project.version} · Updated {relativeTime(project.updatedAt)}</small></span><ArrowRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="modal-note"><Sparkles size={14} /> Create the current-state project first, then start its redesign assessment.</div>
            )}
            {redesignError && <div className="modal-note" style={{ color: "#ef9aa6" }}><CloudOff size={14} /> {redesignError}</div>}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setRedesignOpen(false)}>Cancel</button>
              {projects.length === 0 && <button className="button button-primary" onClick={() => { setRedesignOpen(false); setModalOpen(true); }}>Create project</button>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
