import { createId } from "@designer/core";
import { expect, test, type APIRequestContext, type Locator } from "playwright/test";

interface CreatedDesign {
  version: number;
  document: {
    id: string;
    name: string;
    pages: Array<{ id: string; children: string[] }>;
  };
}

interface EditorFixture {
  designId: string;
  name: string;
  pageId: string;
  frameId: string;
}

interface PrototypeFixture extends EditorFixture {
  actionNodeId: string;
  targetPageId: string;
  targetFrameId: string;
}

async function createEditorFixture(request: APIRequestContext): Promise<EditorFixture> {
  const name = `Enterprise editor IA ${Date.now()}`;
  const response = await request.post("/api/designs", {
    data: {
      name,
      preset: "web",
      idempotencyKey: `editor-ia-${crypto.randomUUID()}`,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const created = await response.json() as CreatedDesign;
  const page = created.document.pages[0];
  const frameId = page?.children[0];
  expect(page?.id).toBeTruthy();
  expect(frameId).toBeTruthy();
  return {
    designId: created.document.id,
    name,
    pageId: page!.id,
    frameId: frameId!,
  };
}

async function createPrototypeFixture(request: APIRequestContext): Promise<PrototypeFixture> {
  const fixture = await createEditorFixture(request);
  const targetPageId = createId("page");
  const actionNodeId = createId("node");
  const targetFrameId = createId("node");
  const navigationLinkId = createId("link");
  const response = await request.post(`/api/designs/${encodeURIComponent(fixture.designId)}/revisions`, {
    data: {
      baseVersion: 1,
      operations: [
        {
          type: "create_page",
          page: { id: targetPageId, name: "Prototype confirmation" },
        },
        {
          type: "create_tree",
          parent: { node_id: fixture.frameId },
          root_ids: [actionNodeId],
          nodes: [{
            id: actionNodeId,
            type: "rectangle",
            name: "Open confirmation",
            layout: {
              x: 96,
              y: 160,
              width: 260,
              height: 64,
              mode: "absolute",
              width_sizing: "fixed",
              height_sizing: "fixed",
            },
            style: { fill: "#675cff", radius: 14 },
            visible: true,
            locked: false,
            archived: false,
            metadata: { semantic_role: "button" },
          }],
        },
        {
          type: "create_tree",
          parent: { page_id: targetPageId },
          root_ids: [targetFrameId],
          nodes: [{
            id: targetFrameId,
            type: "frame",
            name: "Prototype confirmation screen",
            role: "screen",
            children: [],
            clip_content: true,
            layout: {
              x: 0,
              y: 0,
              width: 1440,
              height: 900,
              mode: "absolute",
              width_sizing: "fixed",
              height_sizing: "fixed",
            },
            style: { fill: "#101525" },
            visible: true,
            locked: false,
            archived: false,
            metadata: { locale: "en-US", direction: "ltr" },
          }],
        },
        {
          type: "set_prototype_link",
          link: {
            id: navigationLinkId,
            source_node_id: actionNodeId,
            trigger: { type: "click" },
            action: { type: "navigate", page_id: targetPageId },
            transition: { type: "dissolve", duration_ms: 180, easing: "ease-out" },
            metadata: { flow: "prototype_navigation_test" },
          },
        },
      ],
      idempotencyKey: `editor-prototype-${crypto.randomUUID()}`,
      message: "Add a deterministic click-through prototype",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const committed = await response.json() as {
    document: {
      pages: Array<{ id: string; name: string }>;
      nodes: Record<string, { id: string; name: string }>;
    };
  };
  expect(committed.document.pages).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: targetPageId, name: "Prototype confirmation" }),
  ]));
  expect(committed.document.nodes[actionNodeId]).toMatchObject({ id: actionNodeId, name: "Open confirmation" });
  expect(committed.document.nodes[targetFrameId]).toMatchObject({ id: targetFrameId, name: "Prototype confirmation screen" });
  return {
    ...fixture,
    actionNodeId,
    targetPageId,
    targetFrameId,
  };
}

async function expectPressed(button: Locator, pressed: boolean): Promise<void> {
  await expect(button).toHaveAttribute("aria-pressed", String(pressed));
}

test("enterprise editor workspaces are accessible and remain switchable", async ({ page, request }) => {
  const fixture = await createEditorFixture(request);
  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );

  await expect(page.getByRole("button", { name: "Back to projects" })).toBeVisible();
  await expect(page.getByText(fixture.name, { exact: true })).toBeVisible();

  const projectNavigation = page.getByRole("navigation", { name: "Project structure" });
  const pagesButton = projectNavigation.getByRole("button", { name: "pages", exact: true });
  const layersButton = projectNavigation.getByRole("button", { name: "layers", exact: true });
  const componentsButton = projectNavigation.getByRole("button", { name: "components", exact: true });
  const assetsButton = projectNavigation.getByRole("button", { name: "assets", exact: true });
  await expect(projectNavigation).toBeVisible();
  await expect(projectNavigation.getByRole("button")).toHaveCount(4);
  await expectPressed(layersButton, true);

  await pagesButton.click();
  await expectPressed(pagesButton, true);
  await expect(page.locator(".left-sidebar .sidebar-pane").getByText("Pages", { exact: true })).toBeVisible();

  await componentsButton.click();
  await expectPressed(componentsButton, true);
  await expect(page.getByText("No linked components", { exact: true })).toBeVisible();

  await assetsButton.click();
  await expectPressed(assetsButton, true);
  await expect(page.getByText("No uploaded assets", { exact: true })).toBeVisible();

  await layersButton.click();
  await expectPressed(layersButton, true);
  await expect(page.locator(`[data-layer-node-id="${fixture.frameId}"]`)).toBeVisible();

  const designWorkspace = page.getByRole("navigation", { name: "Design workspace" });
  const canvasButton = designWorkspace.getByRole("button", { name: "Canvas", exact: true });
  const prototypeWorkspaceButton = designWorkspace.getByRole("button", { name: "Prototype", exact: true });
  const beforeAfterButton = designWorkspace.getByRole("button", { name: "Before–After", exact: true });
  await expect(designWorkspace.getByRole("button")).toHaveCount(3);
  await expectPressed(canvasButton, true);
  await expect(page.locator(".canvas-editor-root")).toBeVisible();

  await prototypeWorkspaceButton.click();
  await expectPressed(prototypeWorkspaceButton, true);
  await expect(designWorkspace.getByText("Click-through flow", { exact: true })).toBeVisible();
  await expect(page.locator(".editor-inline-prototype")).toBeVisible();

  await beforeAfterButton.click();
  await expectPressed(beforeAfterButton, true);
  await expect(designWorkspace.getByText("Immutable proposal review", { exact: true })).toBeVisible();
  await expect(page.getByText("No archive preview selected", { exact: true })).toBeVisible();

  await canvasButton.click();
  await expectPressed(canvasButton, true);
  await expect(page.locator(".canvas-editor-root")).toBeVisible();

  const inspectorNavigation = page.getByRole("navigation", { name: "Inspector workspace" });
  const rightInspector = page.locator(".right-sidebar-scroll");
  const inspectorExpectations = [
    ["design", "Position & size"],
    ["content", "No direct content"],
    ["component", "Detached layer"],
    ["logic", "Business logic"],
    ["prototype", "Prototype"],
    ["accessibility", "Accessible identity"],
  ] as const;
  await expect(inspectorNavigation.getByRole("button")).toHaveCount(6);
  for (const [tab, visibleText] of inspectorExpectations) {
    const button = inspectorNavigation.getByRole("button", { name: tab, exact: true });
    await button.click();
    await expectPressed(button, true);
    await expect(rightInspector.getByText(visibleText, { exact: true }).first()).toBeVisible();
  }

  const inspectorUtilities = page.getByRole("navigation", { name: "Inspector utilities" });
  const tokensButton = inspectorUtilities.getByRole("button", { name: "tokens", exact: true });
  const historyButton = inspectorUtilities.getByRole("button", { name: "history", exact: true });
  await expect(inspectorUtilities.getByRole("button")).toHaveCount(2);

  await tokensButton.click();
  await expectPressed(tokensButton, true);
  await expect(page.getByRole("textbox", { name: "Token name" })).toBeVisible();

  await historyButton.click();
  await expectPressed(historyButton, true);
  await expect(page.getByRole("button", { name: "Refresh history" })).toBeVisible();
  await expect(page.getByText("Every human and Codex commit is immutable. Restoring creates a new revision.", { exact: true })).toBeVisible();

  const productWorkspace = page.getByRole("region", { name: "Product specification and agent activity" });
  const activityNavigation = productWorkspace.getByRole("navigation", { name: "Workspace activity panels" });
  const activityButton = activityNavigation.getByRole("button", { name: "Agent activity", exact: true });
  const diagnosticsButton = activityNavigation.getByRole("button", { name: "Diagnostics", exact: true });
  const revisionButton = activityNavigation.getByRole("button", { name: "Revision preview", exact: true });
  const handoffButton = activityNavigation.getByRole("button", { name: "Engineering handoff", exact: true });
  await expect(activityNavigation.getByRole("button")).toHaveCount(4);
  await expectPressed(activityButton, true);
  await expect(productWorkspace.getByRole("textbox", { name: "Describe the product, business logic, and constraints" })).toBeVisible();

  await diagnosticsButton.click();
  await expectPressed(diagnosticsButton, true);
  await expect(productWorkspace.getByText("No agent preview yet", { exact: true })).toBeVisible();

  await revisionButton.click();
  await expectPressed(revisionButton, true);
  await expect(productWorkspace.getByText("No revision proposal ready", { exact: true })).toBeVisible();

  await handoffButton.click();
  await expectPressed(handoffButton, true);
  await expect(productWorkspace.locator(".engineering-handoff-panel")).toBeVisible();
  await expect(productWorkspace.getByText("No handoff for this project", { exact: true })).toBeVisible();

  await activityButton.click();
  await expectPressed(activityButton, true);
  await expect(productWorkspace.getByRole("textbox", { name: "Describe the product, business logic, and constraints" })).toBeVisible();

  await page.locator(`[data-layer-node-id="${fixture.frameId}"]`).click();
  await page.keyboard.press("Delete");
  const archiveDialog = page.getByRole("dialog", { name: "Review destructive change" });
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(archiveDialog).toBeHidden();
  await expectPressed(beforeAfterButton, true);
  await expect(page.getByText("Archive comparison", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review commit actions" }).click();
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(archiveDialog.getByRole("button", { name: "Minimize archive review" })).toBeFocused();
  await archiveDialog.getByRole("button", { name: "Discard preview" }).click();
  await expect(archiveDialog).toBeHidden();
  await expect(page.getByText("No archive preview selected", { exact: true })).toBeVisible();
});

test("prototype click actions navigate to the linked frame without mutating the document", async ({ page, request }) => {
  const fixture = await createPrototypeFixture(request);
  const before = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(before.ok(), await before.text()).toBe(true);
  const beforeBody = await before.json() as { version: number; revisionId: string };

  await page.goto(`/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}`);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const prototype = page.locator(".prototype-backdrop");
  await expect(prototype).toBeVisible();
  await expect(prototype.locator(".prototype-target")).toHaveValue(fixture.pageId);

  const action = prototype.locator(`.prototype-node[data-node-id="${fixture.actionNodeId}"]`);
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute("data-action", "true");
  await action.click();

  await expect(prototype.locator(".prototype-target")).toHaveValue(fixture.targetPageId);
  await expect(prototype.locator(`.prototype-node[data-node-id="${fixture.targetFrameId}"]`)).toBeVisible();
  await prototype.getByRole("button", { name: "Close prototype" }).click();
  await expect(prototype).toBeHidden();

  const after = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(after.ok(), await after.text()).toBe(true);
  expect(await after.json()).toMatchObject({ version: beforeBody.version, revisionId: beforeBody.revisionId });
});
