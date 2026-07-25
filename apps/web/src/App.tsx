import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Dashboard } from "./components/Dashboard";
import { Administration } from "./components/Administration";
import { Editor } from "./components/Editor";
import { InspectView } from "./components/InspectView";
import { PreviewReviewPage } from "./components/PreviewReviewPage";
import { RedesignStudio } from "./components/RedesignStudio";
import { SessionAuthentication } from "./components/SessionAuthentication";
import { hasUnsavedDesignerChanges, saveAllDesignerChanges, useDesignerStore } from "./store/designer-store";

export interface ApplicationRoute {
  kind: "dashboard" | "design" | "preview-review" | "inspect" | "administration" | "redesign";
  designId?: string;
  previewId?: string;
  taskId?: string;
  storeId?: string;
  revisionId?: string;
  assessmentId?: string;
}

export function applicationRoute(pathname: string, search = ""): ApplicationRoute {
  if (pathname === "/administration" || pathname === "/administration/backups" || pathname === "/administration/agents") {
    return { kind: "administration" };
  }
  const inspect = pathname.match(/^\/projects\/([^/]+)\/revisions\/([^/]+)\/inspect$/);
  if (inspect?.[1] && inspect[2]) return { kind: "inspect", designId: decodeURIComponent(inspect[1]), revisionId: decodeURIComponent(inspect[2]) };
  const redesign = pathname.match(/^\/redesign\/([^/]+)$/);
  if (redesign?.[1]) return { kind: "redesign", assessmentId: decodeURIComponent(redesign[1]) };
  const review = pathname.match(/^\/design\/([^/]+)\/previews\/([^/]+)\/review$/);
  if (review?.[1] && review[2]) {
    const taskId = new URLSearchParams(search).get("task")?.trim();
    const storeId = new URLSearchParams(search).get("store")?.trim();
    return {
      kind: "preview-review",
      designId: decodeURIComponent(review[1]),
      previewId: decodeURIComponent(review[2]),
      ...(taskId ? { taskId } : {}),
      ...(storeId ? { storeId } : {}),
    };
  }
  const match = pathname.match(/^\/design\/([^/]+)$/);
  return match?.[1] ? { kind: "design", designId: decodeURIComponent(match[1]) } : { kind: "dashboard" };
}

function routeFromLocation(): ApplicationRoute {
  return applicationRoute(window.location.pathname, window.location.search);
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function locationPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function editorLocation(designId: string): string {
  const state = useDesignerStore.getState();
  const url = new URL(`/design/${encodeURIComponent(designId)}`, window.location.origin);
  if (state.activePageId) url.searchParams.set("page", state.activePageId);
  if (state.selectedIds[0]) url.searchParams.set("node", state.selectedIds[0]);
  return `${url.pathname}${url.search}`;
}

interface PendingNavigation {
  destination: string;
}

function AuthenticatedApplication() {
  const [route, setRoute] = useState(routeFromLocation);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const bypassNavigationGuard = useRef(false);
  const navigationDialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const sync = () => {
      const nextRoute = routeFromLocation();
      if (bypassNavigationGuard.current) {
        bypassNavigationGuard.current = false;
        setPendingNavigation(null);
        setNavigationError(null);
        setRoute(nextRoute);
        return;
      }
      const nextDesignId = nextRoute.designId ?? null;
      const designId = route.kind === "design" ? route.designId ?? null : null;
      const state = useDesignerStore.getState();
      const leavingEditor = Boolean(designId) && (nextRoute.kind !== "design" || nextDesignId !== designId);
      if (leavingEditor && designId && state.document && hasUnsavedDesignerChanges(state)) {
        const destination = locationPath();
        window.history.pushState({}, "", editorLocation(designId));
        setPendingNavigation({ destination });
        setNavigationError(null);
        return;
      }
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [route]);

  useEffect(() => {
    if (!pendingNavigation) return;
    window.requestAnimationFrame(() => navigationDialogRef.current?.focus());
  }, [pendingNavigation]);

  const continueNavigation = (destination: string) => {
    bypassNavigationGuard.current = true;
    setPendingNavigation(null);
    setNavigationError(null);
    navigate(destination);
  };

  const saveAndLeave = async () => {
    if (!pendingNavigation || navigationBusy) return;
    setNavigationBusy(true);
    setNavigationError(null);
    try {
      await saveAllDesignerChanges();
      const latest = useDesignerStore.getState();
      if (!hasUnsavedDesignerChanges(latest)) {
        continueNavigation(pendingNavigation.destination);
        return;
      }
      if (latest.archiveReview || latest.saveState === "review") {
        setNavigationError("Review and commit or discard the destructive archive preview before leaving.");
      } else if (latest.saveState === "conflict") {
        setNavigationError("Resolve or explicitly discard the protected version conflict before leaving.");
      } else {
        setNavigationError(latest.error ?? "The changes could not be saved. Your local draft is still open.");
      }
    } catch (cause) {
      setNavigationError(cause instanceof Error ? cause.message : "The changes could not be saved.");
    } finally {
      setNavigationBusy(false);
    }
  };

  const discardAndLeave = () => {
    if (!pendingNavigation || navigationBusy) return;
    useDesignerStore.getState().productBriefGuard?.discard();
    continueNavigation(pendingNavigation.destination);
  };

  const handleNavigationDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !navigationBusy) {
      event.preventDefault();
      setPendingNavigation(null);
      setNavigationError(null);
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(navigationDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? index <= 0 ? buttons.length - 1 : index - 1
      : index < 0 || index === buttons.length - 1 ? 0 : index + 1;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  };

  const content = route.kind === "inspect" && route.designId && route.revisionId
    ? <InspectView projectId={route.designId} revisionId={route.revisionId} />
    : route.kind === "preview-review" && route.designId && route.previewId
      ? <PreviewReviewPage
        designId={route.designId}
        previewId={route.previewId}
        taskId={route.taskId ?? null}
        expectedDataStoreId={route.storeId ?? null}
      />
    : route.kind === "administration"
      ? <Administration />
      : route.kind === "redesign" && route.assessmentId
        ? <RedesignStudio assessmentId={route.assessmentId} />
        : route.kind === "design" && route.designId
          ? <Editor designId={route.designId} />
          : <Dashboard />;

  return (
    <>
      {content}
      {pendingNavigation && (
        <div className="modal-backdrop navigation-warning-backdrop" role="presentation">
          <section
            className="navigation-warning-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="navigation-warning-title"
            aria-describedby="navigation-warning-description"
            tabIndex={-1}
            ref={navigationDialogRef}
            onKeyDown={handleNavigationDialogKeyDown}
          >
            <header>
              <h2 id="navigation-warning-title">Save changes before leaving?</h2>
              <p id="navigation-warning-description">This project has local changes that are not in immutable history yet.</p>
            </header>
            {navigationError && <div className="navigation-warning-error" role="alert">{navigationError}</div>}
            <div className="navigation-warning-actions">
              <button className="button button-primary" disabled={navigationBusy} onClick={() => void saveAndLeave()}>{navigationBusy ? "Saving…" : "Save & leave"}</button>
              <button className="button button-danger" disabled={navigationBusy} onClick={discardAndLeave}>Discard</button>
              <button className="button button-secondary" disabled={navigationBusy} onClick={() => { setPendingNavigation(null); setNavigationError(null); }}>Cancel</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function App() {
  return <SessionAuthentication><AuthenticatedApplication /></SessionAuthentication>;
}
