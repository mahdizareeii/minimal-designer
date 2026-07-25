import {
  Archive,
  ArrowRight,
  BellRing,
  Bot,
  Check,
  Clock3,
  CloudOff,
  Code2,
  Database,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  Monitor,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Server,
  Smartphone,
  Sparkles,
  Tablet,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { navigate } from "../App";
import { createClientKey, DEVICE_PRESETS, type DesignProjectSummary, type DevicePreset } from "../domain";
import {
  ApiError,
  archiveProduct,
  createRedesignAssessment,
  listAgentConnections,
  listOrganizationAgentTasks,
  listProducts,
  listRepositoryInventories,
  renderUrl,
  type ActivityAgentTask,
  type AgentConnectionRecord,
  type ArchivedProductBlocker,
  type ProductSummary,
  type RepositoryInventorySummary,
} from "../lib/api";
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

const inventoryPlatformLabels: Record<string, string> = {
  web: "Web",
  android: "Android",
  ios: "iOS",
  flutter: "Flutter",
  "react-native": "React Native",
  "generic-git": "Generic Git",
};

export function eligibleRedesignInventories(
  inventories: readonly RepositoryInventorySummary[],
): RepositoryInventorySummary[] {
  return inventories.filter((inventory) => inventory.status === "active" && inventory.platforms.length === 1);
}

export function redesignInventoryPresentation(inventory: RepositoryInventorySummary): {
  title: string;
  detail: string;
  limitNotice: string | null;
} {
  const platform = inventoryPlatformLabels[inventory.platforms[0] ?? ""] ?? "Other platform";
  return {
    title: `${platform} inventory`,
    detail: `${inventory.entityCount.toLocaleString()} bounded entities · ${inventory.scannedFileCount.toLocaleString()} files · scanned ${relativeTime(inventory.createdAt)}`,
    limitNotice: inventory.truncated ? "Scan reached its configured limit" : null,
  };
}

export function buildDashboardRedesignRequest(
  project: DesignProjectSummary,
  inventory: RepositoryInventorySummary,
): Parameters<typeof createRedesignAssessment>[0] {
  if (!eligibleRedesignInventories([inventory]).length) {
    throw new Error("An active single-platform repository inventory is required.");
  }
  return {
    designId: project.id,
    inventoryId: inventory.id,
    expectedDesignVersion: project.version,
    brief: "Assess the selected FormaSpec project, document its current state against the selected bounded repository inventory, interview the product manager, and propose a reviewed future state before any implementation work.",
  };
}

interface RedesignSetupDialogProps {
  projects: readonly DesignProjectSummary[];
  inventories: readonly RepositoryInventorySummary[];
  inventoryLoading: boolean;
  inventoryError: string | null;
  ineligibleActiveInventoryCount: number;
  selectedProjectId: string | null;
  selectedInventoryId: string | null;
  redesigning: boolean;
  redesignError: string | null;
  onClose: () => void;
  onCreateProject: () => void;
  onRetryInventories: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectInventory: (inventoryId: string) => void;
  onStart: () => void;
}

export function RedesignSetupDialog({
  projects,
  inventories,
  inventoryLoading,
  inventoryError,
  ineligibleActiveInventoryCount,
  selectedProjectId,
  selectedInventoryId,
  redesigning,
  redesignError,
  onClose,
  onCreateProject,
  onRetryInventories,
  onSelectProject,
  onSelectInventory,
  onStart,
}: RedesignSetupDialogProps) {
  const ready = selectedProjectId !== null && selectedInventoryId !== null;
  return (
    <div className="create-modal redesign-setup-modal" role="dialog" aria-modal="true" aria-labelledby="redesign-title">
      <div className="modal-heading">
        <div><span className="modal-icon"><WandSparkles size={18} /></span><div><h2 id="redesign-title">Redesign an existing product</h2><p>Pin one FormaSpec project and one active Workspace Bridge inventory before assessment.</p></div></div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>

      <section className="redesign-selection-section" aria-labelledby="redesign-project-heading">
        <div className="redesign-selection-heading">
          <span>1</span>
          <div><strong id="redesign-project-heading">Select the current project</strong><small>The assessment is pinned to its exact current design version.</small></div>
        </div>
        {projects.length > 0 ? (
          <div className="redesign-choice-list" role="radiogroup" aria-label="FormaSpec project">
            {projects.map((project) => {
              const selected = selectedProjectId === project.id;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? "is-selected" : ""}
                  key={project.id}
                  disabled={redesigning}
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="redesign-choice-icon"><LayoutDashboard size={15} /></span>
                  <span><strong>{project.name}</strong><small>Version {project.version} · Updated {relativeTime(project.updatedAt)}</small></span>
                  {selected ? <Check size={15} /> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="redesign-guidance"><Sparkles size={16} /><div><strong>Create a current-state project first</strong><span>Redesign Studio requires an exact design version as review evidence.</span></div></div>
        )}
      </section>

      <section className="redesign-selection-section" aria-labelledby="redesign-inventory-heading">
        <div className="redesign-selection-heading">
          <span>2</span>
          <div><strong id="redesign-inventory-heading">Select a repository inventory</strong><small>Only active, bounded, single-platform Workspace Bridge inventories are eligible.</small></div>
        </div>
        {inventoryLoading ? (
          <div className="redesign-guidance"><LoaderCircle size={16} className="spin" /><div><strong>Loading active inventories</strong><span>Checking the server for current path-free repository evidence.</span></div></div>
        ) : inventories.length > 0 ? (
          <div className="redesign-choice-list" role="radiogroup" aria-label="Active repository inventory">
            {inventories.map((inventory) => {
              const selected = selectedInventoryId === inventory.id;
              const presentation = redesignInventoryPresentation(inventory);
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? "is-selected" : ""}
                  key={inventory.id}
                  disabled={redesigning}
                  onClick={() => onSelectInventory(inventory.id)}
                >
                  <span className="redesign-choice-icon"><Database size={15} /></span>
                  <span>
                    <strong>{presentation.title}</strong>
                    <small>{presentation.detail}{presentation.limitNotice ? ` · ${presentation.limitNotice}` : ""}</small>
                  </span>
                  {selected ? <Check size={15} /> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="redesign-guidance is-workspace-bridge">
            <Code2 size={16} />
            <div>
              <strong>{inventoryError ? "Workspace Bridge inventory unavailable" : "Connect the Workspace Bridge first"}</strong>
              <span>
                {inventoryError ?? (ineligibleActiveInventoryCount > 0
                  ? "The active scans combine multiple platforms. Grant and scan each platform separately, then retry."
                  : "Explicitly grant the repository on its workstation and upload one bounded inventory per platform. Repository paths and credentials stay local.")}
              </span>
            </div>
            <button type="button" className="button button-secondary" onClick={onRetryInventories}>Retry</button>
          </div>
        )}
      </section>

      <div className="redesign-assessment-note"><ShieldCheck size={16} /><div><strong>Assessment and planning only</strong><span>This action cannot modify repository source. Implementation remains separately reviewed and explicitly approved.</span></div></div>
      {redesignError && <div className="modal-note is-error"><CloudOff size={14} /> {redesignError}</div>}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose}>Cancel</button>
        {projects.length === 0 ? <button className="button button-primary" onClick={onCreateProject}>Create project</button> : null}
        <button className="button button-primary" disabled={!ready || redesigning || inventoryLoading} onClick={onStart}>
          {redesigning ? <><LoaderCircle size={15} className="spin" /> Creating assessment…</> : <>Start assessment<ArrowRight size={16} /></>}
        </button>
      </div>
    </div>
  );
}

interface DashboardProjectCardProps {
  project: DesignProjectSummary;
  thumbnailIndex: number;
  offline: boolean;
  archiveDisabled: boolean;
  onOpen: () => void;
  onArchive: () => void;
}

export function DashboardProjectCard({
  project,
  thumbnailIndex,
  offline,
  archiveDisabled,
  onOpen,
  onArchive,
}: DashboardProjectCardProps) {
  return (
    <article className="project-card">
      <button
        type="button"
        className="project-card-open"
        aria-label={`Open ${project.name}`}
        onClick={onOpen}
      >
        <div className={`project-thumbnail thumbnail-${thumbnailIndex % 4}`}>
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
          <div><strong dir="auto" title={project.name}>{project.name}</strong><small><Clock3 size={12} /> Updated {relativeTime(project.updatedAt)}</small></div>
          <span className="open-project"><ArrowRight size={16} /></span>
        </div>
      </button>
      <button
        type="button"
        className="project-archive-action"
        aria-label={`Archive Design ${project.name}`}
        title="Archive Design"
        disabled={archiveDisabled}
        onClick={onArchive}
      >
        <Archive size={14} />
      </button>
    </article>
  );
}

interface ArchiveProjectDialogProps {
  project: DesignProjectSummary;
  confirmationName: string;
  archiving: boolean;
  error: string | null;
  onConfirmationNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function ArchiveProjectDialog({
  project,
  confirmationName,
  archiving,
  error,
  onConfirmationNameChange,
  onClose,
  onConfirm,
}: ArchiveProjectDialogProps) {
  const confirmed = confirmationName === project.name;
  return (
    <section className="create-modal archive-project-modal" role="dialog" aria-modal="true" aria-labelledby="archive-project-title" aria-describedby="archive-project-description">
      <div className="modal-heading">
        <div>
          <span className="modal-icon is-danger"><Archive size={18} /></span>
          <div>
            <h2 id="archive-project-title">Archive Design</h2>
            <p id="archive-project-description">Move “{project.name}” out of the active workspace without deleting its history.</p>
          </div>
        </div>
        <button className="icon-button" type="button" disabled={archiving} onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>

      <div className="archive-retention-note">
        <ShieldCheck size={17} />
        <div>
          <strong>Immutable records remain retained</strong>
          <span>The Design disappears from the active workspace, but its revision history and stored assets remain on your server for audit and recovery.</span>
        </div>
      </div>

      <label className="field-label" htmlFor="archive-project-confirmation">
        Type <code>{project.name}</code> to confirm
        <input
          id="archive-project-confirmation"
          className="text-input"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={confirmationName}
          disabled={archiving}
          onChange={(event) => onConfirmationNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && confirmed && !archiving) onConfirm();
          }}
        />
      </label>
      {error && <div className="modal-note is-error" role="alert"><CloudOff size={14} /> {error}</div>}
      <div className="modal-actions">
        <button className="button button-secondary" type="button" disabled={archiving} onClick={onClose}>Cancel</button>
        <button className="button button-danger" type="button" disabled={!confirmed || archiving} onClick={onConfirm}>
          {archiving ? <><LoaderCircle size={15} className="spin" /> Archiving…</> : <><Archive size={15} /> Archive Design</>}
        </button>
      </div>
    </section>
  );
}

function ArchiveProductDialog({
  product,
  confirmationName,
  archiving,
  error,
  blocker,
  onConfirmationNameChange,
  onClose,
  onConfirm,
}: {
  product: ProductSummary;
  confirmationName: string;
  archiving: boolean;
  error: string | null;
  blocker: ArchivedProductBlocker | null;
  onConfirmationNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmed = confirmationName === product.name;
  return <section className="create-modal archive-project-modal archive-product-modal" role="dialog" aria-modal="true" aria-labelledby="archive-product-title">
    <div className="modal-heading">
      <div><span className="modal-icon is-danger"><Archive size={18} /></span><div>
        <h2 id="archive-product-title">Archive Product</h2>
        <p>Archive “{product.name}” only after all of its active Designs have been archived.</p>
      </div></div>
      <button className="icon-button" type="button" disabled={archiving} onClick={onClose} aria-label="Close"><X size={18} /></button>
    </div>
    <div className="archive-retention-note"><ShieldCheck size={17} /><div><strong>Recoverable and non-destructive</strong><span>Restore the Product first, then restore its Designs from the Archived workspace.</span></div></div>
    {blocker && <div className="product-archive-blocker" role="alert">
      <strong>{blocker.activeDesignCount} active {blocker.activeDesignCount === 1 ? "Design blocks" : "Designs block"} this archive</strong>
      <span>Archive these Designs first:</span>
      <ul>{blocker.activeDesigns.map((design) => <li key={design.id}><span dir="auto">{design.name}</span><code>{design.id}</code><small>v{design.version}</small></li>)}</ul>
      {blocker.truncated && <small>Only the first {blocker.activeDesigns.length} blockers are shown.</small>}
    </div>}
    <label className="field-label" htmlFor="archive-product-confirmation">Type <code>{product.name}</code> to confirm
      <input
        id="archive-product-confirmation"
        className="text-input"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={confirmationName}
        disabled={archiving}
        onChange={(event) => onConfirmationNameChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && confirmed && !archiving) onConfirm(); }}
      />
    </label>
    {error && <div className="modal-note is-error" role="alert"><CloudOff size={14} /> {error}</div>}
    <div className="modal-actions">
      <button className="button button-secondary" type="button" disabled={archiving} onClick={onClose}>Cancel</button>
      <button className="button button-danger" type="button" disabled={!confirmed || archiving} onClick={onConfirm}>
        {archiving ? <><LoaderCircle size={15} className="spin" /> Archiving…</> : <><Archive size={15} /> Archive Product</>}
      </button>
    </div>
  </section>;
}

function openLocalLink(value: string): void {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("The workspace link belongs to another server.");
  navigate(`${url.pathname}${url.search}${url.hash}`);
}

export function Dashboard() {
  const projects = useDesignerStore((state) => state.projects);
  const loading = useDesignerStore((state) => state.dashboardLoading);
  const creating = useDesignerStore((state) => state.creating);
  const archivingProjectId = useDesignerStore((state) => state.archivingProjectId);
  const offline = useDesignerStore((state) => state.offline);
  const error = useDesignerStore((state) => state.error);
  const loadProjects = useDesignerStore((state) => state.loadProjects);
  const createProject = useDesignerStore((state) => state.createProject);
  const archiveProject = useDesignerStore((state) => state.archiveProject);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [createProductId, setCreateProductId] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityAgentTask[]>([]);
  const [agentConnections, setAgentConnections] = useState<AgentConnectionRecord[]>([]);
  const [workflowStateLoading, setWorkflowStateLoading] = useState(true);
  const [redesignOpen, setRedesignOpen] = useState(false);
  const [redesignInventories, setRedesignInventories] = useState<RepositoryInventorySummary[]>([]);
  const [ineligibleActiveInventoryCount, setIneligibleActiveInventoryCount] = useState(0);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedRedesignProjectId, setSelectedRedesignProjectId] = useState<string | null>(null);
  const [selectedRedesignInventoryId, setSelectedRedesignInventoryId] = useState<string | null>(null);
  const [redesigning, setRedesigning] = useState(false);
  const [redesignError, setRedesignError] = useState<string | null>(null);
  const [name, setName] = useState("Untitled product flow");
  const [preset, setPreset] = useState<DevicePreset>("web");
  const [archiveTargetId, setArchiveTargetId] = useState<string | null>(null);
  const [archiveConfirmationName, setArchiveConfirmationName] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveProductTargetId, setArchiveProductTargetId] = useState<string | null>(null);
  const [archiveProductConfirmationName, setArchiveProductConfirmationName] = useState("");
  const [archiveProductBusy, setArchiveProductBusy] = useState(false);
  const [archiveProductError, setArchiveProductError] = useState<string | null>(null);
  const [archiveProductBlocker, setArchiveProductBlocker] = useState<ArchivedProductBlocker | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const projectsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const refreshProducts = async () => {
    setProductsLoading(true);
    setProductsError(null);
    try {
      setProducts(await listProducts());
    } catch (cause) {
      setProducts([]);
      setProductsError(cause instanceof Error ? cause.message : "Products could not be loaded.");
    } finally {
      setProductsLoading(false);
    }
  };

  useEffect(() => {
    void refreshProducts();
  }, []);

  const refreshWorkflowState = async () => {
    setWorkflowStateLoading(true);
    const [tasks, connections] = await Promise.allSettled([
      listOrganizationAgentTasks(20),
      listAgentConnections(),
    ]);
    setActivity(tasks.status === "fulfilled" ? tasks.value : []);
    setAgentConnections(connections.status === "fulfilled" ? connections.value : []);
    setWorkflowStateLoading(false);
  };

  useEffect(() => {
    void refreshWorkflowState();
  }, []);

  const loadRedesignInventories = async (isCurrent: () => boolean = () => true) => {
    setInventoryLoading(true);
    setInventoryError(null);
    try {
      const allInventories = await listRepositoryInventories();
      if (!isCurrent()) return;
      const eligible = eligibleRedesignInventories(allInventories);
      setRedesignInventories(eligible);
      setIneligibleActiveInventoryCount(allInventories.filter((inventory) => (
        inventory.status === "active" && inventory.platforms.length !== 1
      )).length);
      setSelectedRedesignInventoryId((current) => (
        eligible.some((inventory) => inventory.id === current) ? current : null
      ));
    } catch {
      if (!isCurrent()) return;
      setRedesignInventories([]);
      setIneligibleActiveInventoryCount(0);
      setSelectedRedesignInventoryId(null);
      setInventoryError("Active inventories could not be loaded. Verify the Workspace Bridge connection and try again.");
    } finally {
      if (isCurrent()) setInventoryLoading(false);
    }
  };

  useEffect(() => {
    if (!redesignOpen) return undefined;
    let current = true;
    void loadRedesignInventories(() => current);
    return () => { current = false; };
  }, [redesignOpen]);

  const productGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const designsByProduct = new Map<string, DesignProjectSummary[]>();
    for (const project of projects) {
      if (!project.productId) continue;
      const designs = designsByProduct.get(project.productId) ?? [];
      designs.push(project);
      designsByProduct.set(project.productId, designs);
    }
    const groups: Array<{ product: ProductSummary; designs: DesignProjectSummary[] }> = [];
    const knownProductIds = new Set(products.map((product) => product.id));
    for (const product of products) {
      const designs = designsByProduct.get(product.id) ?? [];
      const productMatches = !needle
        || product.name.toLocaleLowerCase().includes(needle)
        || product.description.toLocaleLowerCase().includes(needle);
      const visibleDesigns = productMatches || !needle
        ? designs
        : designs.filter((project) => project.name.toLocaleLowerCase().includes(needle));
      if (!needle || productMatches || visibleDesigns.length > 0) groups.push({ product, designs: visibleDesigns });
    }
    const ungrouped = projects.filter((project) => (
      (!project.productId || !knownProductIds.has(project.productId))
      && (!needle || project.name.toLocaleLowerCase().includes(needle))
    ));
    return { groups, ungrouped };
  }, [products, projects, query]);
  const archiveTarget = projects.find((project) => project.id === archiveTargetId) ?? null;
  const archiveProductTarget = products.find((product) => product.id === archiveProductTargetId) ?? null;
  const createTargetProduct = products.find((product) => product.id === createProductId) ?? null;
  const activeConnection = agentConnections.some((connection) => connection.adapter === "codex" && connection.status === "active"
    && (connection.expiresAt === null || new Date(connection.expiresAt).getTime() > Date.now()));
  const awaitingReview = activity.find(({ task, design }) => design.status === "active" && task.status === "awaiting_approval");
  const resumableTask = activity.find(({ task, design }) => design.status === "active" && ["queued", "claimed", "in_progress"].includes(task.status));
  const mostRecentProject = [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const firstDesignProduct = [...products].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;

  const startHere = products.length === 0
    ? {
        eyebrow: "Create your workspace",
        title: "Create the first Product and Design",
        detail: "FormaSpec will keep the Product context and immutable Design history together.",
        action: "Create Product",
        run: () => openCreateDialog(),
      }
    : projects.length === 0 && firstDesignProduct
      ? {
          eyebrow: "Complete your workspace",
          title: `Add the first Design to ${firstDesignProduct.name}`,
          detail: "Keep the existing Product context and start its first immutable Design history.",
          action: "Add Design",
          run: () => openCreateDialog(firstDesignProduct.id),
        }
    : !activeConnection
      ? {
          eyebrow: "One-time Codex setup",
          title: "Connect or install FormaSpec MCP",
          detail: "Connect once, then create every FormaSpec task from Codex or the CLI. Returned previews remain reviewable on this website.",
          action: "Connect / install MCP",
          run: () => navigate("/administration/agents"),
        }
      : awaitingReview
        ? {
            eyebrow: "Preview ready",
            title: `Review ${awaitingReview.design.name}`,
            detail: `Task ${awaitingReview.task.id} returned an exact persisted preview for website approval.`,
            action: "Review preview",
            run: () => awaitingReview.task.reviewDeepLink
              ? openLocalLink(awaitingReview.task.reviewDeepLink)
              : navigate(`/design/${encodeURIComponent(awaitingReview.design.id)}?task=${encodeURIComponent(awaitingReview.task.id)}`),
          }
        : resumableTask
          ? {
              eyebrow: "Agent work in progress",
              title: `Monitor ${resumableTask.design.name}`,
              detail: `Codex/CLI task ${resumableTask.task.id} is ${resumableTask.task.status.replaceAll("_", " ")}. This website keeps its durable status and returned preview.`,
              action: "View task status",
              run: () => navigate(`/design/${encodeURIComponent(resumableTask.design.id)}?task=${encodeURIComponent(resumableTask.task.id)}`),
            }
          : mostRecentProject
            ? {
                eyebrow: "Continue designing",
                title: `Open ${mostRecentProject.name}`,
                detail: `Continue from immutable Design version ${mostRecentProject.version}.`,
                action: "Open Design",
                run: () => navigate(`/design/${encodeURIComponent(mostRecentProject.id)}`),
              }
            : null;

  const openCreateDialog = (productId: string | null = null) => {
    setCreateProductId(productId);
    setName(productId === null ? "Untitled product flow" : "Untitled design");
    setModalOpen(true);
  };

  const submit = async () => {
    const cleanName = name.trim() || "Untitled design";
    try {
      const id = await createProject(cleanName, preset, createProductId ?? undefined);
      setModalOpen(false);
      await refreshProducts();
      navigate(`/design/${encodeURIComponent(id)}`);
    } catch {
      // The store surfaces the domain/network error in the modal and dashboard.
    }
  };

  const openArchiveDialog = (projectId: string) => {
    setArchiveTargetId(projectId);
    setArchiveConfirmationName("");
    setArchiveError(null);
  };

  const closeArchiveDialog = () => {
    if (archivingProjectId !== null) return;
    setArchiveTargetId(null);
    setArchiveConfirmationName("");
    setArchiveError(null);
  };

  const confirmArchive = async () => {
    if (!archiveTarget || archiveConfirmationName !== archiveTarget.name || archivingProjectId !== null) return;
    try {
      await archiveProject(archiveTarget.id, archiveConfirmationName);
      await refreshProducts();
      if (selectedRedesignProjectId === archiveTarget.id) setSelectedRedesignProjectId(null);
      setArchiveTargetId(null);
      setArchiveConfirmationName("");
      setArchiveError(null);
    } catch (cause) {
      if (cause instanceof ApiError && ["VERSION_CONFLICT", "RESOURCE_STATE_CONFLICT"].includes(cause.code)) {
        await loadProjects();
        setArchiveConfirmationName("");
        setArchiveError("The Design changed while this confirmation was open. Its current summary was reloaded; type the name again to confirm.");
        return;
      }
      setArchiveError(cause instanceof Error ? cause.message : "Could not archive the Design.");
    }
  };

  const openArchiveProductDialog = (productId: string) => {
    setArchiveProductTargetId(productId);
    setArchiveProductConfirmationName("");
    setArchiveProductError(null);
    setArchiveProductBlocker(null);
  };

  const closeArchiveProductDialog = () => {
    if (archiveProductBusy) return;
    setArchiveProductTargetId(null);
    setArchiveProductConfirmationName("");
    setArchiveProductError(null);
    setArchiveProductBlocker(null);
  };

  const confirmProductArchive = async () => {
    if (!archiveProductTarget
      || archiveProductConfirmationName !== archiveProductTarget.name
      || archiveProductBusy) return;
    setArchiveProductBusy(true);
    setArchiveProductError(null);
    setArchiveProductBlocker(null);
    try {
      await archiveProduct(archiveProductTarget, createClientKey("product_archive"));
      await Promise.all([refreshProducts(), loadProjects()]);
      setArchiveProductTargetId(null);
      setArchiveProductConfirmationName("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "PRODUCT_NOT_EMPTY") {
        const details = cause.details && typeof cause.details === "object" && !Array.isArray(cause.details)
          ? cause.details as Record<string, unknown>
          : {};
        const activeDesigns = Array.isArray(details.activeDesigns)
          ? details.activeDesigns.flatMap((item) => {
              const value = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
              return value && typeof value.id === "string" && typeof value.name === "string"
                ? [{
                    id: value.id,
                    name: value.name,
                    version: Number(value.version ?? 0),
                    updatedAt: String(value.updatedAt ?? ""),
                  }]
                : [];
            })
          : [];
        setArchiveProductBlocker({
          activeDesignCount: Number(details.activeDesignCount ?? activeDesigns.length),
          activeDesigns,
          truncated: details.truncated === true,
        });
        setArchiveProductError("Archive the listed Designs first. No Product state was changed.");
        return;
      }
      if (cause instanceof ApiError && ["VERSION_CONFLICT", "RESOURCE_STATE_CONFLICT"].includes(cause.code)) {
        await refreshProducts();
        setArchiveProductConfirmationName("");
        setArchiveProductError("The Product changed while this confirmation was open. Its current summary was reloaded; type the name again to confirm.");
        return;
      }
      setArchiveProductError(cause instanceof Error ? cause.message : "Could not archive the Product.");
    } finally {
      setArchiveProductBusy(false);
    }
  };

  const openRedesign = () => {
    setSelectedRedesignProjectId(null);
    setSelectedRedesignInventoryId(null);
    setRedesignInventories([]);
    setIneligibleActiveInventoryCount(0);
    setInventoryError(null);
    setRedesignError(null);
    setRedesignOpen(true);
  };

  const startRedesign = async () => {
    const project = projects.find((candidate) => candidate.id === selectedRedesignProjectId);
    const inventory = redesignInventories.find((candidate) => candidate.id === selectedRedesignInventoryId);
    if (!project || !inventory) {
      setRedesignError("Explicitly select both a current project and an active single-platform inventory.");
      return;
    }
    setRedesigning(true);
    setRedesignError(null);
    try {
      const assessment = await createRedesignAssessment(buildDashboardRedesignRequest(project, inventory));
      setRedesignOpen(false);
      navigate(`/redesign/${encodeURIComponent(assessment.id)}`);
    } catch {
      setRedesignError("The assessment could not be created. Refresh the project and Workspace Bridge inventory, then try again.");
    } finally {
      setRedesigning(false);
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
          <button className="icon-button" aria-label="Open Activity" title="Activity" onClick={() => navigate("/activity")}><BellRing size={15} /></button>
          <button className="icon-button" aria-label="Open Archived workspace" title="Archived" onClick={() => navigate("/archived")}><Archive size={15} /></button>
          <button className="icon-button" aria-label="Open administration" title="Administration" onClick={() => navigate("/administration")}><Settings size={15} /></button>
          <button className="avatar-button" aria-label="Workspace account">MZ</button>
        </div>
      </header>

      <section className="dashboard-main">
        {startHere && <section className="dashboard-start-here" aria-labelledby="dashboard-start-title">
          <div className="dashboard-start-icon">{workflowStateLoading ? <LoaderCircle size={20} className="spin" /> : awaitingReview ? <BellRing size={20} /> : <Sparkles size={20} />}</div>
          <div><span>{workflowStateLoading ? "Checking workspace state" : startHere.eyebrow}</span><h2 id="dashboard-start-title">{startHere.title}</h2><p>{startHere.detail}</p></div>
          <div className="dashboard-start-actions">
            <button className="button button-primary" disabled={workflowStateLoading} onClick={startHere.run}>{startHere.action}<ArrowRight size={14} /></button>
            <button className="button button-secondary" onClick={() => navigate("/activity")}>Activity</button>
          </div>
        </section>}
        <div className="hero-row">
          <div>
            <div className="eyebrow"><Bot size={14} /> AI-first product design and specification</div>
            <h1>Describe the product.<br /><span>FormaSpec structures the work.</span></h1>
            <p>Design screens, document business logic, manage a shared design system, and hand one immutable specification to Codex or another connected agent.</p>
          </div>
          <div className="primary-action-grid" aria-label="Start a FormaSpec workflow">
            <button className="primary-action-card is-primary" onClick={() => openCreateDialog()}>
              <Plus size={20} /><span><strong>Design a new product</strong><small>Start from a structured web, phone, or tablet frame.</small></span><ArrowRight size={16} />
            </button>
            <button className="primary-action-card" onClick={openRedesign}>
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
            <h2>Products and designs</h2>
            <span>{products.length} {products.length === 1 ? "Product" : "Products"} · {projects.length} {projects.length === 1 ? "Design" : "Designs"}</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Products or Designs" />
            {query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
          </label>
        </div>

        {productsError && !offline && <div className="dashboard-catalog-warning" role="alert"><CloudOff size={14} /> {productsError}</div>}

        {loading || productsLoading ? (
          <div className="project-grid" aria-label="Loading projects">
            {[0, 1, 2].map((item) => <div className="project-card project-skeleton" key={item} />)}
          </div>
        ) : productGroups.groups.length > 0 || productGroups.ungrouped.length > 0 ? (
          <div className="product-sections">
            {productGroups.groups.map(({ product, designs }, groupIndex) => (
              <section className="product-section" key={product.id} aria-labelledby={`product-title-${product.id}`}>
                <header className="product-section-header">
                  <div>
                    <span className="product-section-mark"><FolderOpen size={15} /></span>
                    <div>
                      <h3 id={`product-title-${product.id}`} dir="auto" title={product.name}>{product.name}</h3>
                      <p>{product.description || `${product.designCount} ${product.designCount === 1 ? "Design" : "Designs"} · ${product.defaultLocale.toUpperCase()} · ${product.defaultDirection.toUpperCase()}`}</p>
                    </div>
                  </div>
                  <div className="product-section-actions">
                    <button className="button button-secondary" onClick={() => navigate("/archived")}><Archive size={14} /> Archived</button>
                    <button className="button button-secondary" disabled={archiveProductBusy} onClick={() => openArchiveProductDialog(product.id)}><Archive size={14} /> Archive Product</button>
                    <button className="button button-secondary" onClick={() => openCreateDialog(product.id)}><Plus size={14} /> Add design</button>
                  </div>
                </header>
                <div className="project-grid">
                  {designs.map((project, index) => (
                    <DashboardProjectCard
                      key={project.id}
                      project={project}
                      thumbnailIndex={(groupIndex * 100) + index}
                      offline={offline}
                      archiveDisabled={archivingProjectId !== null}
                      onOpen={() => navigate(`/design/${encodeURIComponent(project.id)}`)}
                      onArchive={() => openArchiveDialog(project.id)}
                    />
                  ))}
                  <button className="project-card new-project-card" onClick={() => openCreateDialog(product.id)}>
                    <span><Plus size={22} /></span>
                    <strong>Add a design</strong>
                    <small>Keep it inside {product.name}</small>
                  </button>
                </div>
              </section>
            ))}
            {productGroups.ungrouped.length > 0 && (
              <section className="product-section is-unresolved" aria-labelledby="unresolved-designs-title">
                <header className="product-section-header">
                  <div><span className="product-section-mark"><Database size={15} /></span><div><h3 id="unresolved-designs-title">Unresolved Product context</h3><p>These legacy Designs need an administrator-reviewed Product move.</p></div></div>
                </header>
                <div className="project-grid">
                  {productGroups.ungrouped.map((project, index) => (
                    <DashboardProjectCard
                      key={project.id}
                      project={project}
                      thumbnailIndex={index}
                      offline={offline}
                      archiveDisabled={archivingProjectId !== null}
                      onOpen={() => navigate(`/design/${encodeURIComponent(project.id)}`)}
                      onArchive={() => openArchiveDialog(project.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : offline ? (
          <div className="empty-projects">
            <div className="empty-orbit" style={{ color: "#efb664", borderColor: "#5a462b" }}><CloudOff size={24} /></div>
            <h3>Connect the self-hosted design server</h3>
            <p>{error ?? "Start the API on port 4310, then reload this workspace."}</p>
            <button className="button button-secondary" onClick={() => { void loadProjects(); void refreshProducts(); }}><Server size={15} /> Retry connection</button>
          </div>
        ) : (
          <div className="empty-projects">
            <div className="empty-orbit"><Sparkles size={24} /></div>
            <h3>{query ? "No Products or Designs match that search" : "Your first Product is waiting"}</h3>
            <p>{query ? "Try another Product or Design name." : "Create a Product with its first structured Design."}</p>
            {!query && <button className="button button-primary" onClick={() => openCreateDialog()}><Plus size={16} /> Design a new product</button>}
          </div>
        )}
      </section>

      <footer className="dashboard-footer">
        <span><Check size={13} /> Your design data stays on your server</span>
          <span>FormaSpec 0.4 · @FormaSpec agent</span>
      </footer>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setModalOpen(false); }}>
          <div className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="modal-heading">
              <div><span className="modal-icon"><Plus size={18} /></span><div><h2 id="create-title">{createTargetProduct ? `New design in ${createTargetProduct.name}` : "New product design"}</h2><p>{createTargetProduct ? "Add a separately versioned Design to this Product." : "Create a Product and its first structured Design."}</p></div></div>
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
            <div className="modal-note"><Sparkles size={14} /> {createTargetProduct ? `This Design inherits ${createTargetProduct.name}'s Product context and default design-system release.` : "You can add more Designs and web, phone, or tablet frames after creation."}</div>
            {error && <div className="modal-note" style={{ color: "#ef9aa6" }}><CloudOff size={14} /> {error}</div>}
            <div className="modal-actions">
              <button className="button button-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="button button-primary" disabled={creating} onClick={() => void submit()}>{creating ? "Creating…" : "Create design"}<ArrowRight size={16} /></button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeArchiveDialog();
        }}>
          <ArchiveProjectDialog
            project={archiveTarget}
            confirmationName={archiveConfirmationName}
            archiving={archivingProjectId === archiveTarget.id}
            error={archiveError}
            onConfirmationNameChange={(value) => { setArchiveConfirmationName(value); setArchiveError(null); }}
            onClose={closeArchiveDialog}
            onConfirm={() => void confirmArchive()}
          />
        </div>
      )}

      {archiveProductTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeArchiveProductDialog();
        }}>
          <ArchiveProductDialog
            product={archiveProductTarget}
            confirmationName={archiveProductConfirmationName}
            archiving={archiveProductBusy}
            error={archiveProductError}
            blocker={archiveProductBlocker}
            onConfirmationNameChange={(value) => {
              setArchiveProductConfirmationName(value);
              setArchiveProductError(null);
              setArchiveProductBlocker(null);
            }}
            onClose={closeArchiveProductDialog}
            onConfirm={() => void confirmProductArchive()}
          />
        </div>
      )}

      {redesignOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setRedesignOpen(false); }}>
          <RedesignSetupDialog
            projects={projects}
            inventories={redesignInventories}
            inventoryLoading={inventoryLoading}
            inventoryError={inventoryError}
            ineligibleActiveInventoryCount={ineligibleActiveInventoryCount}
            selectedProjectId={selectedRedesignProjectId}
            selectedInventoryId={selectedRedesignInventoryId}
            redesigning={redesigning}
            redesignError={redesignError}
            onClose={() => setRedesignOpen(false)}
            onCreateProject={() => { setRedesignOpen(false); openCreateDialog(); }}
            onRetryInventories={() => void loadRedesignInventories()}
            onSelectProject={(projectId) => { setSelectedRedesignProjectId(projectId); setRedesignError(null); }}
            onSelectInventory={(inventoryId) => { setSelectedRedesignInventoryId(inventoryId); setRedesignError(null); }}
            onStart={() => void startRedesign()}
          />
        </div>
      )}
    </main>
  );
}
