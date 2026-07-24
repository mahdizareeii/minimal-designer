import { createDesignPage, createStarterDocument } from "@designer/core";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { useDesignerStore } from "../store/designer-store";

describe("explicit editor save and page-management contract", () => {
  beforeEach(() => {
    const document = createStarterDocument({
      preset: "web",
      name: "A deliberately long project title that must never overlap the editor controls",
    });
    document.revision = 4;
    document.pages.push(createDesignPage({
      name: "A deliberately long secondary page title that must stay inside its own row",
    }));
    useDesignerStore.setState({
      document,
      baseVersion: document.revision,
      activePageId: document.pages[0]!.id,
      selectedIds: [],
      editorLoading: false,
      pendingOperations: [],
      saving: false,
      saveState: "saved",
      archiveReview: null,
      conflictRecovery: null,
      error: null,
      notice: null,
    });
  });

  it("keeps a persistent textual Save / Commit control beside a visible save-state indicator", () => {
    const editorSource = readFileSync(new URL("../components/Editor.tsx", import.meta.url), "utf8");

    expect(editorSource).toContain('className="document-title"');
    expect(editorSource).toContain('archiveReview ? "Review pending destructive changes" : "Save now"');
    expect(editorSource).toContain("Save / Commit");
    expect(editorSource).toContain("save-status is-${workspaceSaveState}");
    expect(editorSource).toContain('archiveReview ? "Review changes" : "Save / Commit"');
  });

  it("has no ordinary-edit autosave and exposes the three in-app leave choices", () => {
    const editorSource = readFileSync(new URL("../components/Editor.tsx", import.meta.url), "utf8");
    const storeSource = readFileSync(new URL("../store/designer-store.ts", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const componentLibrarySource = readFileSync(new URL("../components/ComponentLibraryPanel.tsx", import.meta.url), "utf8");
    const projectPinsSource = readFileSync(new URL("../components/DesignSystemProjectPins.tsx", import.meta.url), "utf8");

    expect(editorSource).not.toContain("setTimeout(() => void save(), 950)");
    expect(editorSource).toContain('window.addEventListener("beforeunload"');
    expect(appSource).toContain("Save & leave");
    expect(appSource).toContain(">Discard</button>");
    expect(appSource).toContain(">Cancel</button>");
    expect(appSource).not.toContain("window.confirm");
    expect(componentLibrarySource).not.toContain("Commit this exact component insertion preview");
    expect(projectPinsSource).not.toContain("Commit this exact design-system release upgrade");
    expect(editorSource).toContain("useProjectContextPresence");
    expect(editorSource).not.toContain("updateContext({ designId: null");
    expect(storeSource).not.toContain("updateContext(");
    expect(editorSource).toContain('data-testid="project-context-presence"');
  });

  it("reserves page-row delete space and constrains long project and page titles", () => {
    const layersSource = readFileSync(new URL("../components/LayersPanel.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(layersSource).toContain('className="page-row-shell"');
    expect(layersSource).toContain('className="page-row-delete"');
    expect(layersSource).toContain('role="dialog"');
    expect(layersSource).toContain("Create deletion preview");
    expect(layersSource).toContain("Immutable history remains recoverable");
    expect(layersSource).not.toContain("window.confirm");
    expect(styles).toMatch(/\.editor-topbar-left\s*\{[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.document-title strong\s*\{[^}]*text-overflow:\s*ellipsis;/s);
    expect(styles).toMatch(/\.page-row-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 28px;/s);
    expect(styles).toMatch(/\.page-row-detailed strong\s*\{[^}]*text-overflow:\s*ellipsis;/s);
    expect(styles).toMatch(/\.canvas-frame-label strong\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  });
});
