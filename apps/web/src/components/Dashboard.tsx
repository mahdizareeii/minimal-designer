import {
  ArrowRight,
  Bot,
  Check,
  Clock3,
  CloudOff,
  Code2,
  LayoutDashboard,
  Monitor,
  Plus,
  Search,
  Server,
  Smartphone,
  Sparkles,
  Tablet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { navigate } from "../App";
import { DEVICE_PRESETS, type DevicePreset } from "../domain";
import { renderUrl } from "../lib/api";
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
  const [name, setName] = useState("Untitled product flow");
  const [preset, setPreset] = useState<DevicePreset>("web");

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

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate("/"); }}>
          <span className="brand-mark"><Sparkles size={16} strokeWidth={2.4} /></span>
          <span>Forma</span>
          <span className="brand-badge">Private beta</span>
        </a>
        <div className="dashboard-header-actions">
          <div className={`connection-pill ${offline ? "is-offline" : ""}`}>
            {offline ? <CloudOff size={14} /> : <Server size={14} />}
            {offline ? "Server unavailable" : "Self-hosted"}
          </div>
          <button className="avatar-button" aria-label="Workspace account">MZ</button>
        </div>
      </header>

      <section className="dashboard-main">
        <div className="hero-row">
          <div>
            <div className="eyebrow"><Bot size={14} /> AI-first design workspace</div>
            <h1>Turn product intent into<br /><span>clear interface systems.</span></h1>
            <p>Codex builds on a structured canvas. Your team reviews, adjusts, and ships from one versioned source of truth.</p>
          </div>
          <button className="button button-primary button-large" onClick={() => setModalOpen(true)}>
            <Plus size={18} /> New design
          </button>
        </div>

        <div className="workflow-strip" aria-label="Workflow">
          <div><span>01</span><Bot size={18} /><strong>Describe</strong><small>Tell Codex what the product needs</small></div>
          <ArrowRight className="workflow-arrow" size={18} />
          <div><span>02</span><LayoutDashboard size={18} /><strong>Review</strong><small>Inspect and refine the live canvas</small></div>
          <ArrowRight className="workflow-arrow" size={18} />
          <div><span>03</span><Code2 size={18} /><strong>Handoff</strong><small>Export versioned JSON to build from</small></div>
        </div>

        <div className="projects-toolbar">
          <div>
            <h2>Recent designs</h2>
            <span>{projects.length} {projects.length === 1 ? "project" : "projects"}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search designs" />
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
        <span>Forma 0.1 · Structured canvas</span>
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
    </main>
  );
}
