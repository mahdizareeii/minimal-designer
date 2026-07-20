import { useEffect, useState } from "react";

import { Dashboard } from "./components/Dashboard";
import { Administration } from "./components/Administration";
import { Editor } from "./components/Editor";
import { InspectView } from "./components/InspectView";
import { RedesignStudio } from "./components/RedesignStudio";
import { useDesignerStore } from "./store/designer-store";

interface ApplicationRoute {
  kind: "dashboard" | "design" | "inspect" | "administration" | "redesign";
  designId?: string;
  revisionId?: string;
  assessmentId?: string;
}

function routeFromLocation(): ApplicationRoute {
  if (window.location.pathname === "/administration" || window.location.pathname === "/administration/backups" || window.location.pathname === "/administration/agents") {
    return { kind: "administration" };
  }
  const inspect = window.location.pathname.match(/^\/projects\/([^/]+)\/revisions\/([^/]+)\/inspect$/);
  if (inspect?.[1] && inspect[2]) return { kind: "inspect", designId: decodeURIComponent(inspect[1]), revisionId: decodeURIComponent(inspect[2]) };
  const redesign = window.location.pathname.match(/^\/redesign\/([^/]+)$/);
  if (redesign?.[1]) return { kind: "redesign", assessmentId: decodeURIComponent(redesign[1]) };
  const match = window.location.pathname.match(/^\/design\/([^/]+)$/);
  return match?.[1] ? { kind: "design", designId: decodeURIComponent(match[1]) } : { kind: "dashboard" };
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [route, setRoute] = useState(routeFromLocation);

  useEffect(() => {
    const sync = () => {
      const nextRoute = routeFromLocation();
      const nextDesignId = nextRoute.designId ?? null;
      const designId = route.kind === "design" ? route.designId ?? null : null;
      const state = useDesignerStore.getState();
      const unresolved = Boolean(state.document)
        && (state.saving
          || state.pendingOperations.length > 0
          || state.saveState === "dirty"
          || state.saveState === "error"
          || state.saveState === "conflict");
      const leavingEditor = Boolean(designId) && (nextRoute.kind !== "design" || nextDesignId !== designId);
      if (leavingEditor && designId && unresolved
        && !window.confirm("These edits are not saved. Leave the designer and discard the local draft?")) {
        const url = new URL(window.location.href);
        url.pathname = `/design/${encodeURIComponent(designId)}`;
        url.search = "";
        if (state.activePageId) url.searchParams.set("page", state.activePageId);
        if (state.selectedIds[0]) url.searchParams.set("node", state.selectedIds[0]);
        window.history.pushState({}, "", `${url.pathname}${url.search}`);
        return;
      }
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [route]);

  if (route.kind === "inspect" && route.designId && route.revisionId) {
    return <InspectView projectId={route.designId} revisionId={route.revisionId} />;
  }
  if (route.kind === "administration") return <Administration />;
  if (route.kind === "redesign" && route.assessmentId) return <RedesignStudio assessmentId={route.assessmentId} />;
  if (route.kind === "design" && route.designId) return <Editor designId={route.designId} />;
  return <Dashboard />;
}
