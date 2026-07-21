import { createComponentNode, createDesignPage, createStarterDocument } from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { InspectorPanel } from "../components/InspectorPanel";
import { LayersPanel, selectNodeAcrossPages } from "../components/LayersPanel";
import {
  ACTIVITY_PANEL_TABS,
  CENTER_WORKSPACE_TABS,
  INSPECTOR_UTILITY_TABS,
  LEFT_PANEL_TABS,
  PRIMARY_INSPECTOR_TABS,
  isPrimaryInspectorTab,
} from "../lib/editor-information-architecture";
import { useDesignerStore } from "../store/designer-store";

describe("enterprise editor information architecture", () => {
  beforeEach(() => {
    const document = createStarterDocument({ preset: "web", name: "Enterprise editor" });
    useDesignerStore.setState({
      document,
      baseVersion: document.revision,
      activePageId: document.pages[0]!.id,
      selectedIds: [document.pages[0]!.children[0]!],
      inspectorTab: "design",
      pendingOperations: [],
      undoStack: [],
      redoStack: [],
      revisions: [],
      saveState: "saved",
      saving: false,
    });
  });

  it("keeps the exact project, workspace, inspector, and activity surfaces stable", () => {
    expect(LEFT_PANEL_TABS).toEqual(["pages", "layers", "components", "assets"]);
    expect(CENTER_WORKSPACE_TABS).toEqual(["canvas", "prototype", "before-after"]);
    expect(PRIMARY_INSPECTOR_TABS).toEqual([
      "design",
      "content",
      "component",
      "logic",
      "prototype",
      "accessibility",
    ]);
    expect(INSPECTOR_UTILITY_TABS).toEqual(["tokens", "history"]);
    expect(ACTIVITY_PANEL_TABS).toEqual(["activity", "diagnostics", "revision", "handoff"]);
    for (const tabs of [
      LEFT_PANEL_TABS,
      CENTER_WORKSPACE_TABS,
      PRIMARY_INSPECTOR_TABS,
      INSPECTOR_UTILITY_TABS,
      ACTIVITY_PANEL_TABS,
    ]) expect(new Set(tabs).size).toBe(tabs.length);
  });

  it("renders all primary editor navigation while preserving token and history utilities", () => {
    const left = renderToStaticMarkup(<LayersPanel />);
    for (const tab of LEFT_PANEL_TABS) expect(left).toContain(`>${tab}</button>`);

    const inspector = renderToStaticMarkup(<InspectorPanel />);
    for (const tab of PRIMARY_INSPECTOR_TABS) expect(inspector).toContain(`>${tab}</button>`);
    for (const tab of INSPECTOR_UTILITY_TABS) expect(inspector).toContain(tab);
  });

  it("navigates to a component or asset usage page before selecting its node", () => {
    const document = createStarterDocument({ preset: "web" });
    const secondPage = createDesignPage({ name: "Second page" });
    const component = createComponentNode({ name: "Cross-page component", component_key: "cross.page" });
    secondPage.children.push(component.id);
    document.pages.push(secondPage);
    document.nodes[component.id] = component;
    const calls: string[] = [];

    expect(selectNodeAcrossPages(
      document,
      component.id,
      (pageId) => calls.push(`page:${pageId}`),
      (nodeIds) => calls.push(`nodes:${nodeIds.join(",")}`),
    )).toBe(true);
    expect(calls).toEqual([`page:${secondPage.id}`, `nodes:${component.id}`]);
  });

  it("switches between primary and utility inspector workspaces without losing selection", () => {
    const selected = [...useDesignerStore.getState().selectedIds];
    for (const tab of [...PRIMARY_INSPECTOR_TABS, ...INSPECTOR_UTILITY_TABS]) {
      useDesignerStore.getState().setInspectorTab(tab);
      expect(useDesignerStore.getState().inspectorTab).toBe(tab);
      expect(useDesignerStore.getState().selectedIds).toEqual(selected);
      expect(isPrimaryInspectorTab(tab)).toBe((PRIMARY_INSPECTOR_TABS as readonly string[]).includes(tab));
    }
  });
});
