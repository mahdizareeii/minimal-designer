import { useEffect, useState } from "react";

import { Dashboard } from "./components/Dashboard";
import { Editor } from "./components/Editor";
import { useDesignerStore } from "./store/designer-store";

function designIdFromLocation(): string | null {
  const match = window.location.pathname.match(/^\/design\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function App() {
  const [designId, setDesignId] = useState(designIdFromLocation);

  useEffect(() => {
    const sync = () => {
      const nextDesignId = designIdFromLocation();
      const state = useDesignerStore.getState();
      const unresolved = Boolean(state.document)
        && (state.saving
          || state.pendingOperations.length > 0
          || state.saveState === "dirty"
          || state.saveState === "error"
          || state.saveState === "conflict");
      if (!nextDesignId && designId && unresolved
        && !window.confirm("These edits are not saved. Leave the designer and discard the local draft?")) {
        const url = new URL(window.location.href);
        url.pathname = `/design/${encodeURIComponent(designId)}`;
        url.search = "";
        if (state.activePageId) url.searchParams.set("page", state.activePageId);
        if (state.selectedIds[0]) url.searchParams.set("node", state.selectedIds[0]);
        window.history.pushState({}, "", `${url.pathname}${url.search}`);
        return;
      }
      setDesignId(nextDesignId);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [designId]);

  return designId ? <Editor designId={designId} /> : <Dashboard />;
}
