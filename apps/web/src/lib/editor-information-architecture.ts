export const LEFT_PANEL_TABS = ["pages", "layers", "components", "assets"] as const;
export type LeftPanelTab = (typeof LEFT_PANEL_TABS)[number];

export const CENTER_WORKSPACE_TABS = ["canvas", "prototype", "before-after"] as const;
export type CenterWorkspaceTab = (typeof CENTER_WORKSPACE_TABS)[number];

export const PRIMARY_INSPECTOR_TABS = [
  "design",
  "content",
  "component",
  "logic",
  "prototype",
  "accessibility",
] as const;
export type PrimaryInspectorTab = (typeof PRIMARY_INSPECTOR_TABS)[number];

export const INSPECTOR_UTILITY_TABS = ["tokens", "history"] as const;
export type InspectorUtilityTab = (typeof INSPECTOR_UTILITY_TABS)[number];
export type InspectorPanelTab = PrimaryInspectorTab | InspectorUtilityTab;

export const ACTIVITY_PANEL_TABS = ["activity", "diagnostics", "revision", "handoff"] as const;
export type ActivityPanelTab = (typeof ACTIVITY_PANEL_TABS)[number];

export function isPrimaryInspectorTab(tab: InspectorPanelTab): tab is PrimaryInspectorTab {
  return (PRIMARY_INSPECTOR_TABS as readonly string[]).includes(tab);
}
