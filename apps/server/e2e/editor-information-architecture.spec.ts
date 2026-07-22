import { createId, createTextNode } from "@designer/core";
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

interface V2EditorFixture extends EditorFixture {
  version: number;
}

async function createEditorFixture(
  request: APIRequestContext,
  name = `Enterprise editor IA ${Date.now()}`,
): Promise<EditorFixture> {
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

async function createV2EditorFixture(request: APIRequestContext): Promise<V2EditorFixture> {
  const fixture = await createEditorFixture(request);
  const backupResponse = await request.post("/api/backups", { data: {} });
  expect(backupResponse.ok(), await backupResponse.text()).toBe(true);
  const backup = await backupResponse.json() as { backup: { id: string; status: string } };
  expect(backup.backup.status).toBe("valid");
  const migrationResponse = await request.post(
    `/api/designs/${encodeURIComponent(fixture.designId)}/migrations/v2`,
    {
      data: {
        expectedBaseVersion: 1,
        backupId: backup.backup.id,
        idempotencyKey: `editor-component-migration-${crypto.randomUUID()}`,
      },
    },
  );
  expect(migrationResponse.ok(), await migrationResponse.text()).toBe(true);
  const migrated = await migrationResponse.json() as { version: number; schemaVersion: number };
  expect(migrated).toMatchObject({ version: 2, schemaVersion: 2 });
  return { ...fixture, version: migrated.version };
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
  await page.getByTitle("Save now").click();
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

test("long project and page titles stay truncated inside their reserved controls", async ({ page, request }) => {
  const projectName = "Enterprise dispatch operations workspace with a deliberately long project title that must never overlap save or panel controls";
  const pageName = "Customer support escalation and bilingual incident-resolution workflow with an intentionally long page title";
  const fixture = await createEditorFixture(request, projectName);
  const longPageId = createId("page");
  const revision = await request.post(`/api/designs/${encodeURIComponent(fixture.designId)}/revisions`, {
    data: {
      baseVersion: 1,
      operations: [{ type: "create_page", page: { id: longPageId, name: pageName } }],
      idempotencyKey: `long-editor-titles-${crypto.randomUUID()}`,
      message: "Add a long page-title overflow fixture",
    },
  });
  expect(revision.ok(), await revision.text()).toBe(true);

  await page.goto(`/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(longPageId)}`);
  const projectNavigation = page.getByRole("navigation", { name: "Project structure" });
  await projectNavigation.getByRole("button", { name: "pages", exact: true }).click();

  const documentTitle = page.locator(".document-title strong");
  const panelToggle = page.getByRole("button", { name: "Toggle panels" });
  const projectMetrics = await documentTitle.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      right: bounds.right,
      overflow: getComputedStyle(element).overflow,
      textOverflow: getComputedStyle(element).textOverflow,
    };
  });
  const panelToggleBox = await panelToggle.boundingBox();
  expect(projectMetrics.scrollWidth).toBeGreaterThan(projectMetrics.clientWidth);
  expect(projectMetrics.overflow).toBe("hidden");
  expect(projectMetrics.textOverflow).toBe("ellipsis");
  expect(panelToggleBox).not.toBeNull();
  expect(projectMetrics.right).toBeLessThanOrEqual(panelToggleBox!.x + 0.75);

  const pageRow = page.locator(`[data-page-id="${longPageId}"]`);
  const pageTitle = pageRow.locator("strong");
  const deleteButton = pageRow.getByRole("button", { name: `Delete page ${pageName}` });
  const pageMetrics = await pageTitle.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      right: bounds.right,
      overflow: getComputedStyle(element).overflow,
      textOverflow: getComputedStyle(element).textOverflow,
    };
  });
  const deleteBox = await deleteButton.boundingBox();
  expect(pageMetrics.scrollWidth).toBeGreaterThan(pageMetrics.clientWidth);
  expect(pageMetrics.overflow).toBe("hidden");
  expect(pageMetrics.textOverflow).toBe("ellipsis");
  expect(deleteBox).not.toBeNull();
  expect(pageMetrics.right).toBeLessThanOrEqual(deleteBox!.x + 0.75);
});

test("page archival stays unsaved until Save / Commit and leaving offers save, discard, or cancel", async ({ page, request }) => {
  const fixture = await createEditorFixture(request);
  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );

  const projectNavigation = page.getByRole("navigation", { name: "Project structure" });
  await projectNavigation.getByRole("button", { name: "pages", exact: true }).click();
  await page.getByRole("button", { name: "Add page" }).click();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(page.getByTitle("Save now")).toBeEnabled();
  await expect(page.locator(".save-status")).toContainText("Unsaved");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  await page.waitForTimeout(1_200);
  const beforeExplicitSave = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(beforeExplicitSave.ok(), await beforeExplicitSave.text()).toBe(true);
  expect(await beforeExplicitSave.json()).toMatchObject({ version: 1 });

  await page.getByRole("button", { name: "Back to projects" }).click();
  const leaveDialog = page.getByRole("dialog", { name: "Save changes before leaving?" });
  await expect(leaveDialog).toBeVisible();
  await expect(leaveDialog.getByRole("button", { name: "Save & leave" })).toBeVisible();
  await expect(leaveDialog.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(leaveDialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await leaveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(leaveDialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/design/${fixture.designId}`));

  await page.getByRole("button", { name: "Back to projects" }).click();
  await leaveDialog.getByRole("button", { name: "Save & leave" }).click();
  await expect(page).toHaveURL(/\/$/);
  const afterSaveAndLeave = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(afterSaveAndLeave.ok(), await afterSaveAndLeave.text()).toBe(true);
  const saved = await afterSaveAndLeave.json() as {
    version: number;
    document: { pages: Array<{ id: string; name: string; archived: boolean }> };
  };
  expect(saved.version).toBe(2);
  const secondPage = saved.document.pages.find((candidate) => candidate.name === "Page 2");
  expect(secondPage).toBeTruthy();
  expect(secondPage?.archived).toBe(false);

  await page.goto(`/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(secondPage!.id)}`);
  await projectNavigation.getByRole("button", { name: "pages", exact: true }).click();
  const deleteSecondPage = page.getByRole("button", { name: "Delete page Page 2" });
  const confirmationPromise = page.waitForEvent("dialog");
  const deleteClick = deleteSecondPage.click();
  const confirmation = await confirmationPromise;
  expect(confirmation.message()).toContain("Archive page “Page 2”?");
  expect(confirmation.message()).toContain("recoverable in immutable history");
  await confirmation.accept();
  await deleteClick;

  await expect(page.getByText("Page 2", { exact: true })).toBeHidden();
  await expect(page.locator(".save-status")).toContainText("Unsaved");
  const beforeArchiveCommit = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(beforeArchiveCommit.ok(), await beforeArchiveCommit.text()).toBe(true);
  expect(await beforeArchiveCommit.json()).toMatchObject({
    version: 2,
    document: { pages: expect.arrayContaining([expect.objectContaining({ id: secondPage!.id, archived: false })]) },
  });

  await page.getByTitle("Save now").click();
  const archiveDialog = page.getByRole("dialog", { name: "Review destructive change" });
  await expect(archiveDialog).toBeVisible();
  const stillUncommitted = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(stillUncommitted.ok(), await stillUncommitted.text()).toBe(true);
  expect(await stillUncommitted.json()).toMatchObject({ version: 2 });
  await archiveDialog.getByRole("button", { name: "Commit archive" }).click();
  await expect(archiveDialog).toBeHidden();
  await expect(page.locator(".document-title")).toContainText("Version 3");

  const committedResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(committedResponse.ok(), await committedResponse.text()).toBe(true);
  const committed = await committedResponse.json() as {
    version: number;
    document: { pages: Array<{ id: string; archived: boolean }> };
  };
  expect(committed.version).toBe(3);
  expect(committed.document.pages.find((candidate) => candidate.id === secondPage!.id)?.archived).toBe(true);
  expect(committed.document.pages.filter((candidate) => !candidate.archived)).toHaveLength(1);

  const historyResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}/history`);
  expect(historyResponse.ok(), await historyResponse.text()).toBe(true);
  const history = await historyResponse.json() as { revisions: Array<{ version: number }> };
  expect(history.revisions.map((revision) => revision.version)).toEqual(expect.arrayContaining([1, 2, 3]));
  await expect(page.getByRole("button", { name: /Delete page / })).toBeDisabled();
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

test("pinned components preview exactly and commit through the ordinary revision workflow", async ({ page, request }) => {
  const fixture = await createV2EditorFixture(request);
  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );

  const projectNavigation = page.getByRole("navigation", { name: "Project structure" });
  await projectNavigation.getByRole("button", { name: "components", exact: true }).click();
  const library = page.getByRole("region", { name: "Pinned component library" });
  await expect(library).toBeVisible();
  await expect(library.getByText(/FormaSpec Foundation/)).toBeVisible();
  const componentSelect = library.locator("label", { hasText: "Component" }).locator("select").first();
  const parentSelect = library.locator("label", { hasText: "Insert into" }).locator("select");
  await expect(componentSelect).toBeEnabled();
  await expect(parentSelect).toHaveValue(`node:${fixture.frameId}`);

  await library.getByRole("button", { name: "Create exact preview" }).click();
  const preview = library.locator(".component-insertion-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Ready to commit", { exact: true })).toBeVisible();
  await expect(preview.locator("img")).toBeVisible();

  const isolatedHead = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(isolatedHead.ok(), await isolatedHead.text()).toBe(true);
  expect(await isolatedHead.json()).toMatchObject({ version: fixture.version, schemaVersion: 2 });

  await preview.getByRole("button", { name: "Commit insertion" }).click();
  await expect(page.locator(".document-title")).toContainText("Version 3");
  await expect(page.locator(".toast")).toContainText(/Inserted .+ in revision 3\./);

  const committedHead = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(committedHead.ok(), await committedHead.text()).toBe(true);
  const committed = await committedHead.json() as {
    version: number;
    schemaVersion: number;
    document: { nodes: Record<string, { type: string; archived: boolean }> };
  };
  expect(committed).toMatchObject({ version: 3, schemaVersion: 2 });
  expect(Object.values(committed.document.nodes).some((node) => node.type === "instance" && !node.archived)).toBe(true);
});

test("product brief submission shows progress, persists the specification, queues a task, and keeps failures visible", async ({ page, request }) => {
  const fixture = await createEditorFixture(request);
  await page.addInitScript(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.protocol === "codex:") {
        (window as unknown as { __formaspecSubmitLink?: string }).__formaspecSubmitLink = this.href;
        return;
      }
      originalClick.call(this);
    };
  });
  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );

  const workspace = page.getByRole("region", { name: "Product specification and agent activity" });
  const textbox = workspace.getByRole("textbox", { name: "Describe the product, business logic, and constraints" });
  const submit = workspace.getByRole("button", { name: "Submit to @FormaSpec" });
  await expect(textbox).toBeEnabled();
  await expect(submit).toBeEnabled();

  await submit.click();
  const submitStatus = workspace.getByTestId("formaspec-submit-status");
  await expect(submitStatus).toHaveAttribute("role", "alert");
  await expect(submitStatus).toContainText("Describe the product, business logic, and constraints");
  await expect(submit).toBeEnabled();

  const taskEndpoint = `**/api/designs/${fixture.designId}/agent-tasks`;
  let releaseTaskRequest!: () => void;
  let markTaskRequestSeen!: () => void;
  const taskRequestGate = new Promise<void>((resolve) => { releaseTaskRequest = resolve; });
  const taskRequestSeen = new Promise<void>((resolve) => { markTaskRequestSeen = resolve; });
  await page.route(taskEndpoint, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    markTaskRequestSeen();
    await taskRequestGate;
    await route.continue();
  });

  const brief = "Design an accessible bilingual dispatch dashboard with clear urgent-order states and audited assignment rules.";
  await textbox.fill(brief);
  await submit.click();
  await expect(submitStatus).toHaveAttribute("role", "status");
  await expect(submitStatus).toContainText("Submitting to @FormaSpec");
  await expect(submit).toBeDisabled();
  await taskRequestSeen;
  await expect(submitStatus).toContainText("Creating an immutable design task and direct Codex launch action");
  releaseTaskRequest();

  await expect(submitStatus).toContainText("Task ready for Codex");
  await expect(submitStatus).toContainText("is queued");
  const directOpen = submitStatus.getByRole("button", { name: "Open task in Codex" });
  await expect(directOpen).toBeVisible();
  await directOpen.click();
  const launchUrl = await page.evaluate(() => (window as unknown as { __formaspecSubmitLink?: string }).__formaspecSubmitLink);
  expect(launchUrl).toBeTruthy();
  expect(new URL(launchUrl!).searchParams.get("prompt")).toContain("[@FormaSpec](plugin://formaspec@formaspec)");

  const specificationResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}/product-specification`);
  expect(specificationResponse.ok(), await specificationResponse.text()).toBe(true);
  expect(await specificationResponse.json()).toMatchObject({ version: 1, naturalLanguageBrief: brief });
  const tasksResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}/agent-tasks`);
  expect(tasksResponse.ok(), await tasksResponse.text()).toBe(true);
  const tasks = await tasksResponse.json() as { tasks: Array<{ id: string; status: string; brief: string }> };
  expect(tasks.tasks[0]).toMatchObject({ status: "queued", brief });
  await page.unroute(taskEndpoint);

  let releaseFailure!: () => void;
  let markFailureSeen!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const failureSeen = new Promise<void>((resolve) => { markFailureSeen = resolve; });
  await page.route(taskEndpoint, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    markFailureSeen();
    await failureGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "TEMPORARY_UNAVAILABLE", message: "Injected task queue failure for visible feedback." } }),
    });
  });
  await textbox.fill(`${brief} Include a permission-denied state.`);
  await submit.click();
  await failureSeen;
  await expect(submitStatus).toContainText("Creating an immutable design task and direct Codex launch action");
  releaseFailure();
  await expect(submitStatus).toHaveAttribute("role", "alert");
  await expect(submitStatus).toContainText("Submission failed");
  await expect(submitStatus).toContainText("Injected task queue failure for visible feedback.");
  await expect(submit).toBeEnabled();
  await expect(submitStatus).toBeVisible();
});

test("website design commands capture the Codex launch URL and simulate the MCP preview workflow with approval actions", async ({ page, request }) => {
  const fixture = await createEditorFixture(request);
  // This browser suite captures the generated protocol URL and drives the
  // authenticated MCP contract directly. Coverage of OS protocol handling,
  // managed plugin loading, and a real Codex client is intentionally not
  // provided by this suite.
  await page.addInitScript(() => {
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.protocol === "codex:" || this.protocol === "formaspec:") {
        (window as unknown as { __formaspecExternalLink?: string }).__formaspecExternalLink = this.href;
        return;
      }
      originalClick.call(this);
    };
  });
  const challengeResponse = await request.post("/api/agent-connections", {
    data: {
      adapter: "codex",
      displayName: "Editor workflow Codex",
      scopes: ["design:read", "design:preview", "design:write", "task:read", "task:claim", "task:update"],
      projectIds: [fixture.designId],
      expiresInSeconds: 3_600,
    },
  });
  expect(challengeResponse.ok(), await challengeResponse.text()).toBe(true);
  const challenge = await challengeResponse.json() as { nonce: string; connection: { status: string } };
  expect(challenge.connection.status).toBe("pending");
  const pairResponse = await request.post("/api/agent-connections/pair", { data: { nonce: challenge.nonce } });
  expect(pairResponse.ok(), await pairResponse.text()).toBe(true);
  const paired = await pairResponse.json() as { connection: { status: string }; grant: { token: string } };
  expect(paired.connection.status).toBe("active");
  let mcpRequestId = 1;
  const callTool = async <T extends Record<string, unknown>>(name: string, arguments_: Record<string, unknown>): Promise<T & { ok: true }> => {
    const response = await request.post("/mcp", {
      headers: {
        authorization: `Bearer ${paired.grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      data: { jsonrpc: "2.0", id: mcpRequestId++, method: "tools/call", params: { name, arguments: arguments_ } },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const envelope = await response.json() as {
      error?: { message?: string };
      result?: { structuredContent?: T & { ok?: boolean; error?: { code?: string; message?: string } } };
    };
    expect(envelope.error?.message).toBeUndefined();
    const structured = envelope.result?.structuredContent;
    expect(structured?.ok, structured?.error?.message).toBe(true);
    return structured as T & { ok: true };
  };

  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );
  const productWorkspace = page.getByRole("region", { name: "Product specification and agent activity" });
  const workflow = productWorkspace.getByRole("complementary", { name: "Agent task workflow" });
  await expect(workflow.getByText("active", { exact: true })).toBeVisible();
  await expect(workflow.getByText("Connected and ready to claim tasks.", { exact: true })).toBeVisible();

  await productWorkspace.getByRole("textbox", { name: "Describe the product, business logic, and constraints" }).fill(
    "Design a professional dispatch overview with a clear urgent-order state, accessible actions, and RTL-safe content.",
  );
  await productWorkspace.getByRole("button", { name: "Submit to @FormaSpec" }).click();
  await expect(workflow.getByText("Task created. Click Open task in Codex below so @FormaSpec can claim it.", { exact: true })).toBeVisible();

  const tasksResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}/agent-tasks`);
  expect(tasksResponse.ok(), await tasksResponse.text()).toBe(true);
  const tasks = await tasksResponse.json() as { tasks: Array<{ id: string; status: string }> };
  const task = tasks.tasks[0]!;
  expect(task.status).toBe("queued");
  expect(await page.evaluate(() => (window as unknown as { __formaspecExternalLink?: string }).__formaspecExternalLink)).toBeUndefined();
  const openTask = workflow.getByRole("button", { name: "Open task in Codex" });
  await expect(openTask).toBeVisible();
  await openTask.click();
  const codexLink = await page.evaluate(() => (window as unknown as { __formaspecExternalLink?: string }).__formaspecExternalLink);
  expect(codexLink).toBeTruthy();
  const parsedCodexLink = new URL(codexLink!);
  expect(parsedCodexLink.protocol).toBe("codex:");
  expect(parsedCodexLink.hostname).toBe("new");
  expect(parsedCodexLink.searchParams.get("prompt")).toContain("[@FormaSpec](plugin://formaspec@formaspec)");
  expect(parsedCodexLink.searchParams.get("prompt")).toContain(task.id);
  await expect(workflow.getByRole("button", { name: "Copy Codex instruction" })).toBeVisible();

  const claimed = await callTool<{ task: { status: string } }>("task_claim", { task_id: task.id });
  expect(claimed.task.status).toBe("claimed");
  const progressed = await callTool<{ task: { status: string } }>("task_transition", {
    task_id: task.id,
    expected_status: "claimed",
    to_status: "in_progress",
    message: "Building the requested dispatch overview.",
  });
  expect(progressed.task.status).toBe("in_progress");
  await expect(workflow.getByText("Building the requested dispatch overview.", { exact: true })).toBeVisible();

  const previewed = await callTool<{ preview: { id: string; canCommit: boolean } }>("design_preview_changes", {
    design_id: fixture.designId,
    base_version: 1,
    max_size: 720,
    operations: [{
      type: "update_node",
      node_id: fixture.frameId,
      patch: { name: "Agent-designed dispatch overview", metadata: { agent_workflow_e2e: true } },
    }],
  });
  expect(previewed.preview.canCommit).toBe(true);
  const approval = await callTool<{ task: { status: string } }>("task_transition", {
    task_id: task.id,
    expected_status: "in_progress",
    to_status: "awaiting_approval",
    message: "Rendered preview is ready for product-manager approval.",
    data: { previewId: previewed.preview.id },
  });
  expect(approval.task.status).toBe("awaiting_approval");

  const renderedPreview = workflow.getByRole("img", { name: "FormaSpec rendered preview" });
  await expect(renderedPreview).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => renderedPreview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const approvalActions = workflow.getByRole("group", { name: "Agent preview approval actions" });
  await expect(approvalActions.getByRole("button", { name: "Discard" })).toBeVisible();
  await expect(approvalActions.getByRole("button", { name: "Commit exact preview" })).toBeEnabled();

  await approvalActions.getByRole("button", { name: "Commit exact preview" }).click();
  await expect(page.locator(".document-title")).toContainText("Version 2", { timeout: 15_000 });
  await expect(workflow.getByText("The exact preview was approved and the task is complete.", { exact: true })).toBeVisible();
  const committedResponse = await request.get(`/api/designs/${encodeURIComponent(fixture.designId)}`);
  expect(committedResponse.ok(), await committedResponse.text()).toBe(true);
  expect(await committedResponse.json()).toMatchObject({
    version: 2,
    document: { nodes: { [fixture.frameId]: { name: "Agent-designed dispatch overview" } } },
  });
});

test("editor chrome has a readable minimum size without changing canonical canvas typography", async ({ page, request }) => {
  const fixture = await createEditorFixture(request);
  const tinyText = createTextNode({
    name: "Canonical tiny canvas text",
    content: "Canonical 8px canvas text",
    direction: "ltr",
    layout: { x: 40, y: 40, width: 220, height: 24 },
    style: {
      fill: "#ffffff",
      typography: {
        font_family: "Inter",
        font_size: 8,
        font_weight: 400,
        line_height: 1.2,
      },
    },
  });
  const revision = await request.post(`/api/designs/${encodeURIComponent(fixture.designId)}/revisions`, {
    data: {
      baseVersion: 1,
      operations: [{
        type: "create_tree",
        parent: { node_id: fixture.frameId },
        root_ids: [tinyText.id],
        nodes: [tinyText],
      }],
      idempotencyKey: `readable-editor-${crypto.randomUUID()}`,
      message: "Add canonical tiny text for chrome-isolation verification",
    },
  });
  expect(revision.ok(), await revision.text()).toBe(true);

  await page.goto(
    `/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );
  await expect(page.locator(".canvas-editor-root")).toBeVisible();

  const tinyCanvasText = page.locator(`[data-node-id="${tinyText.id}"]`);
  await expect(tinyCanvasText).toBeVisible();
  expect(await tinyCanvasText.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBe(8);

  const tooSmall = await page.locator(".editor-shell").evaluate((editor) => {
    const roots = editor.querySelectorAll<HTMLElement>([
      ".editor-topbar",
      ".left-sidebar",
      ".right-sidebar",
      ".editor-stage-tabs",
      ".editor-statusbar",
      ".product-workspace-panel",
    ].join(","));
    const candidates = new Set<HTMLElement>();
    for (const root of roots) {
      for (const candidate of root.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, label, span, small, p, code, strong, h2, h3",
      )) candidates.add(candidate);
    }
    return [...candidates].flatMap((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return [];
      const size = Number.parseFloat(getComputedStyle(candidate).fontSize);
      const control = ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(candidate.tagName);
      const emphasized = ["STRONG", "H2", "H3"].includes(candidate.tagName);
      const minimum = control || emphasized ? 13 : 12;
      return size + 0.01 < minimum
        ? [{ tag: candidate.tagName, text: candidate.textContent?.trim().slice(0, 80) ?? "", size, minimum }]
        : [];
    });
  });
  expect(tooSmall).toEqual([]);
});

test("dashboard readability floors preserve the semantic hero hierarchy", async ({ page }) => {
  await page.goto("/");
  const hero = page.locator(".hero-row h1");
  const emphasized = hero.locator("span");
  await expect(hero).toBeVisible();
  const sizes = await hero.evaluate((heading) => ({
    heading: Number.parseFloat(getComputedStyle(heading).fontSize),
    emphasized: Number.parseFloat(getComputedStyle(heading.querySelector("span")!).fontSize),
  }));
  expect(sizes.heading).toBeGreaterThanOrEqual(36);
  expect(sizes.emphasized).toBeCloseTo(sizes.heading, 3);
});
