import { expect, test, type APIRequestContext } from "playwright/test";

interface OrganizationPolicyRecord {
  configurationHash: string;
  policy: {
    accessibility: {
      minimumTouchTargetPx: number;
    };
  };
}

async function readPolicy(request: APIRequestContext): Promise<OrganizationPolicyRecord> {
  const response = await request.get("/api/organization/policy");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { organizationPolicy: OrganizationPolicyRecord }).organizationPolicy;
}

test("organization policy is editable through the guided administration form", async ({ page, request }) => {
  const before = await readPolicy(request);
  let submittedBody: unknown;
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PUT" && outgoing.url().endsWith("/api/organization/policy")) {
      submittedBody = outgoing.postDataJSON();
    }
  });

  await page.goto("/administration");
  await expect(page.getByText("FormaSpec Administration", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Guided settings" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "Export YAML" })).toHaveAttribute(
    "href",
    "/api/organization/configuration",
  );

  for (const section of [
    "Localization",
    "Platforms",
    "Design-system policy",
    "Assets",
    "Naming",
    "Accessibility",
    "Agents and scopes",
    "Repositories",
    "Backups and retention",
    "Identity mappings",
    "Audit",
    "Exports",
  ]) {
    await expect(page.getByText(section, { exact: true })).toBeVisible();
  }

  const touchTarget = page.getByLabel("Minimum touch target");
  await expect(touchTarget).toHaveValue(String(before.policy.accessibility.minimumTouchTargetPx));
  await touchTarget.fill("48");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Organization policy was validated, saved, audited, and applied.", { exact: true }))
    .toBeVisible();

  expect(submittedBody).toMatchObject({
    expectedConfigurationHash: before.configurationHash,
    policy: { accessibility: { minimumTouchTargetPx: 48 } },
  });
  const after = await readPolicy(request);
  expect(after.configurationHash).not.toBe(before.configurationHash);
  expect(after.policy.accessibility.minimumTouchTargetPx).toBe(48);

  await page.getByRole("button", { name: "Expert JSON" }).click();
  await expect(page.getByRole("textbox", { name: "Organization policy JSON" })).toHaveValue(
    /"minimumTouchTargetPx": 48/,
  );
});
