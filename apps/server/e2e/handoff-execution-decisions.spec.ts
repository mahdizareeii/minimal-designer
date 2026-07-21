import { expect, test, type APIRequestContext, type Locator, type Page } from "playwright/test";

interface CreatedDesign {
  version: number;
  revisionId: string;
  document: {
    id: string;
    name: string;
    pages: Array<{ id: string; children: string[] }>;
  };
}

interface RepositoryInventory {
  id: string;
  inventoryHash: string;
  status: "active" | "superseded" | "revoked";
}

interface EngineeringHandoff {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  inventoryId: string;
  status: "draft" | "in_review" | "approved" | "implementing" | "completed" | "cancelled";
  currentVersion: number;
}

interface HandoffFixture {
  design: CreatedDesign;
  pageId: string;
  frameId: string;
  inventory: RepositoryInventory;
  inventoryEntityId: string;
  handoff: EngineeringHandoff;
}

interface HandoffMutation {
  path: string;
  body: unknown;
}

const DIFF_HASH = "d".repeat(64);
const VALIDATION_HASH = "e".repeat(64);

async function responseJson<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  const body = await response.text();
  expect(response.ok(), body).toBe(true);
  return JSON.parse(body) as T;
}

async function createHandoffFixture(request: APIRequestContext): Promise<HandoffFixture> {
  const suffix = crypto.randomUUID();
  const created = await responseJson<CreatedDesign>(await request.post("/api/designs", {
    data: {
      name: `Execution decisions ${suffix.slice(0, 8)}`,
      preset: "web",
      idempotencyKey: `handoff-e2e-design-${suffix}`,
    },
  }));
  const page = created.document.pages[0];
  const frameId = page?.children[0];
  expect(page?.id).toBeTruthy();
  expect(frameId).toBeTruthy();

  const inventoryEntityId = `inv_${"1".repeat(40)}`;
  const inventoryEnvelope = await responseJson<{ inventory: RepositoryInventory }>(
    await request.post("/api/repository-inventories", {
      data: {
        schemaVersion: 1,
        repositoryFingerprint: "a".repeat(64),
        generatedAt: "2026-07-21T09:00:00.000Z",
        platforms: ["web"],
        gitHead: "b".repeat(40),
        scannedFileCount: 8,
        skippedFileCount: 2,
        bytesRead: 8_192,
        truncated: false,
        excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
        entities: [{
          id: inventoryEntityId,
          kind: "component",
          name: "CheckoutScreen",
          symbol: "CheckoutScreen",
          locationId: `loc_${"2".repeat(40)}`,
          line: 24,
        }],
        excluded: [
          { category: "secret", count: 1 },
          { category: "generated", count: 1 },
        ],
      },
    }),
  );

  const handoffEnvelope = await responseJson<{ handoff: EngineeringHandoff }>(
    await request.post(`/api/designs/${encodeURIComponent(created.document.id)}/handoffs`, {
      data: {
        revisionId: created.revisionId,
        expectedDesignVersion: created.version,
        inventoryId: inventoryEnvelope.inventory.id,
        specification: {
          schemaVersion: 1,
          title: "Implement the exact reviewed checkout",
          summary: "Implement one bounded checkout slice from the immutable FormaSpec revision and repository inventory.",
          acceptanceCriteria: [{
            id: "checkout_matches_revision",
            statement: "The checkout matches the exact approved FormaSpec revision.",
            designEntityIds: [frameId],
          }],
          implementationSlices: [{
            id: "checkout_slice",
            title: "Checkout screen",
            objective: "Implement the reviewed checkout without unrelated source changes.",
            inventoryEntityIds: [inventoryEntityId],
            designEntityIds: [frameId],
            dependsOn: [],
            validationChecks: ["typecheck", "unit_tests", "build"],
          }],
          risks: ["The implementation must remain bounded to the reviewed revision and inventory."],
          openQuestions: [],
          implementationPolicy: {
            preferredIsolation: "worktree",
            commitRequiresExplicitApproval: true,
            pullRequestRequiresExplicitRequest: true,
          },
        },
      },
    }),
  );

  const submitted = await responseJson<{ handoff: EngineeringHandoff }>(
    await request.post(`/api/handoffs/${encodeURIComponent(handoffEnvelope.handoff.id)}/submit-review`, {
      data: {
        expectedVersion: handoffEnvelope.handoff.currentVersion,
        summary: "Ready for explicit browser-reviewed execution decisions.",
      },
    }),
  );

  return {
    design: created,
    pageId: page!.id,
    frameId: frameId!,
    inventory: inventoryEnvelope.inventory,
    inventoryEntityId,
    handoff: submitted.handoff,
  };
}

function gateCard(review: Locator, title: string): Locator {
  return review.locator(".execution-gate-card").filter({ hasText: title });
}

async function expectCurrentOutcome(card: Locator, outcome: string): Promise<void> {
  await expect(card.locator(".execution-gate-outcome")).toHaveText(outcome);
  await expect(card.locator(".execution-current-decision")).toBeVisible();
}

function captureHandoffMutations(page: Page, handoffId: string): HandoffMutation[] {
  const mutations: HandoffMutation[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (!url.pathname.startsWith(`/api/handoffs/${encodeURIComponent(handoffId)}/`)) return;
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    mutations.push({ path: url.pathname, body });
  });
  return mutations;
}

function allObjectKeys(value: unknown, target = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allObjectKeys(item, target);
    return target;
  }
  if (typeof value !== "object" || value === null) return target;
  for (const [key, child] of Object.entries(value)) {
    target.add(key);
    allObjectKeys(child, target);
  }
  return target;
}

test("browser enforces immutable handoff execution decisions before start and completion", async ({ page, request }) => {
  test.setTimeout(120_000);
  test.info().annotations.push({
    type: "coverage-limit",
    description: "Local mode exposes one organization-admin browser identity; independent role authorization remains covered by HTTP/MCP integration tests.",
  });
  const fixture = await createHandoffFixture(request);
  const mutations = captureHandoffMutations(page, fixture.handoff.id);

  await page.goto(
    `/design/${encodeURIComponent(fixture.design.document.id)}?page=${encodeURIComponent(fixture.pageId)}&node=${encodeURIComponent(fixture.frameId)}`,
  );
  const productWorkspace = page.getByRole("region", { name: "Product specification and agent activity" });
  await productWorkspace.getByRole("button", { name: "Engineering handoff", exact: true }).click();
  const panel = productWorkspace.locator(".engineering-handoff-panel");
  await expect(panel).toBeVisible();

  await panel.getByLabel("Active repository inventory").selectOption(fixture.inventory.id);
  await expect(panel.getByText("Design v1", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText(fixture.design.revisionId, { exact: true })).toBeVisible();
  await expect(panel.getByText(fixture.inventory.inventoryHash, { exact: true })).toBeVisible();

  const handoffCard = panel.locator(".handoff-list > article").filter({
    hasText: "Implement the exact reviewed checkout",
  });
  await expect(handoffCard).toContainText("Design v1 · Handoff v1");
  await expect(handoffCard).toContainText(fixture.handoff.id);
  await expect(handoffCard.locator(".handoff-status")).toHaveText("in review");
  await handoffCard.getByRole("button", { name: "Review gates" }).click();

  const review = panel.getByRole("region", { name: `Execution decisions for ${fixture.handoff.id}` });
  await expect(review).toBeVisible();
  await expect(review.getByText("Start 2 blocked", { exact: true })).toBeVisible();
  await expect(review.getByText("0 immutable decisions", { exact: true })).toBeVisible();

  const planCard = gateCard(review, "Plan approval");
  await planCard.getByLabel("Evidence summary").fill("Reviewed the exact revision, acceptance criteria, and bounded implementation plan.");
  await planCard.getByLabel("I reviewed the acceptance criteria.").check();
  await planCard.getByLabel("I reviewed the implementation slices.").check();
  await planCard.getByRole("button", { name: "Approve reviewed plan" }).click();
  await expectCurrentOutcome(planCard, "approved");

  const startButton = review.getByRole("button", { name: "Authorize implementation stage" });
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeDisabled();
  await expect(review.getByText("Start is blocked by: isolation_choice.", { exact: true })).toBeVisible();

  const isolationCard = gateCard(review, "Isolation");
  await isolationCard.getByLabel("Isolation decision").selectOption("worktree");
  await isolationCard.getByLabel("Evidence summary").fill("Use a dedicated worktree for the approved implementation.");
  await isolationCard.getByRole("button", { name: "Record decision" }).click();
  await expectCurrentOutcome(isolationCard, "worktree");
  await expect(startButton).toBeEnabled();
  await expect(review.getByText("The approved plan and isolation choice are current.", { exact: true })).toBeVisible();
  await startButton.click();

  const completionButton = review.getByRole("button", { name: "Complete from decisions" });
  await expect(completionButton).toBeVisible();
  await expect(completionButton).toBeDisabled();
  await expect(review.getByText(/Completion is blocked by: diff_review, validation_approval, commit_approval, push_authorization, pull_request_request/)).toBeVisible();

  const diffCard = gateCard(review, "Diff review");
  await diffCard.getByLabel("Evidence summary").fill("Reviewed the exact bounded implementation diff.");
  await diffCard.getByLabel("Diff SHA-256").fill(DIFF_HASH);
  await diffCard.getByLabel("Changed file count").fill("4");
  await diffCard.getByRole("button", { name: "Record decision" }).click();
  await expectCurrentOutcome(diffCard, "approved");
  await expect(diffCard).toContainText("4 changed files");
  await expect(completionButton).toBeDisabled();

  const validationCard = gateCard(review, "Validation");
  for (const check of ["typecheck", "unit tests", "build"]) {
    const checkbox = validationCard.getByLabel(`${check} · required`);
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeDisabled();
  }
  await validationCard.getByLabel("Evidence summary").fill("All validation required by the immutable handoff plan passed.");
  await validationCard.getByLabel("Shared evidence SHA-256 (optional)").fill(VALIDATION_HASH);
  await validationCard.getByRole("button", { name: "Record decision" }).click();
  await expectCurrentOutcome(validationCard, "approved");
  await expect(validationCard).toContainText("Passed: typecheck, unit_tests, build");

  const commitCard = gateCard(review, "Commit approval");
  await expect(commitCard.getByLabel("Reviewed diff SHA-256")).toHaveValue(DIFF_HASH);
  await commitCard.getByLabel("Evidence summary").fill("Approve a commit for only the exact reviewed diff.");
  await commitCard.getByLabel("Approved commit message").fill("Implement approved checkout handoff");
  await commitCard.getByRole("button", { name: "Record decision" }).click();
  await expectCurrentOutcome(commitCard, "approved");
  await expect(completionButton).toBeDisabled();

  const pushCard = gateCard(review, "Push disposition");
  await pushCard.getByLabel("Push disposition decision").selectOption("denied");
  await pushCard.getByLabel("Denial reason").fill("Keep the approved commit local; pushing is explicitly denied.");
  await pushCard.getByRole("button", { name: "Record denial" }).click();
  await expectCurrentOutcome(pushCard, "denied");

  const pullRequestCard = gateCard(review, "Pull request disposition");
  await pullRequestCard.getByLabel("Pull request disposition decision").selectOption("not_requested");
  await pullRequestCard.getByLabel("Reason no pull request is requested").fill("No pull request is requested for this bounded local implementation.");
  await pullRequestCard.getByRole("button", { name: "Record no pull request" }).click();
  await expectCurrentOutcome(pullRequestCard, "not requested");

  await expect(review.getByText("All seven current dispositions satisfy completion rules.", { exact: true })).toBeVisible();
  await expect(completionButton).toBeDisabled();
  const completionSummary = "Completed only the approved mapped checkout slice and retained the local commit.";
  await review.getByLabel("Implementation completion summary").fill(completionSummary);
  await expect(completionButton).toBeEnabled();
  await completionButton.click();

  await expect(handoffCard.locator(".handoff-status")).toHaveText("completed");
  await expect(review.getByText("Current handoff status: completed.", { exact: true })).toBeVisible();
  await expect(review.getByText("7 immutable decisions", { exact: true })).toBeVisible();
  await review.locator(".execution-decision-history > summary").click();
  await expect(review.locator(".execution-decision-history article")).toHaveCount(7);
  await expect(review.locator(".execution-decision-history")).toContainText("Push disposition · denied");
  await expect(review.locator(".execution-decision-history")).toContainText("Pull request disposition · not requested");

  await expect(review.getByRole("textbox", { name: /repository path|workspace path|source path|shell command/i })).toHaveCount(0);
  const completionMutation = mutations.find((mutation) => mutation.path.endsWith("/complete"));
  expect(completionMutation?.body).toEqual({
    expectedVersion: fixture.handoff.currentVersion,
    summary: completionSummary,
  });
  const startMutation = mutations.find((mutation) => mutation.path.endsWith("/start-implementation"));
  expect(startMutation?.body).toEqual({
    expectedVersion: fixture.handoff.currentVersion,
    approvedVersion: fixture.handoff.currentVersion,
    authorization: "start_implementation",
  });
  const approvalMutation = mutations.find((mutation) => mutation.path.endsWith("/approve"));
  expect(approvalMutation?.body).toMatchObject({
    expectedVersion: fixture.handoff.currentVersion,
    expectedPriorDecisionId: null,
    decision: "approved",
    acceptanceCriteriaConfirmed: true,
    implementationPlanConfirmed: true,
  });

  const mutationKeys = new Set<string>();
  for (const mutation of mutations) allObjectKeys(mutation.body, mutationKeys);
  for (const forbidden of [
    "diffReviewed",
    "validationApproved",
    "commitApproved",
    "pullRequestRequested",
    "sourcePath",
    "repositoryPath",
    "workspacePath",
    "shell",
    "command",
  ]) expect(mutationKeys.has(forbidden), `forbidden mutation field ${forbidden}`).toBe(false);

  const mutationText = JSON.stringify(mutations);
  expect(mutationText).not.toMatch(/\/Users\/|[A-Za-z]:\\\\Users\\\\|password=|token=/i);

  const persisted = await responseJson<{ handoff: EngineeringHandoff }>(
    await request.get(`/api/handoffs/${encodeURIComponent(fixture.handoff.id)}`),
  );
  expect(persisted.handoff).toMatchObject({
    id: fixture.handoff.id,
    designId: fixture.design.document.id,
    revisionId: fixture.design.revisionId,
    designVersion: fixture.design.version,
    inventoryId: fixture.inventory.id,
    status: "completed",
  });
});
