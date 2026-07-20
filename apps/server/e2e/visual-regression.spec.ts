import { expect, test, type Page } from "playwright/test";

import { createVisualFixture, visualFixtureKinds } from "./visual-fixtures.js";

async function waitForDeterministicPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => {
      if (image.complete && image.naturalWidth > 0) return image.decode().catch(() => undefined);
      return new Promise<void>((resolve, reject) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => reject(new Error(`Image failed to load: ${image.currentSrc}`)), { once: true });
      });
    }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test.describe("representative structured-design visual baselines", () => {
  for (const kind of visualFixtureKinds) {
    test(`${kind} prototype matches its approved baseline`, async ({ page, request }) => {
      const fixture = await createVisualFixture(request, kind);
      await page.goto(`/design/${encodeURIComponent(fixture.designId)}?page=${encodeURIComponent(fixture.pageId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(`[data-node-id="${fixture.rootId}"]`)).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBe(1);

      await page.getByRole("button", { name: "Preview", exact: true }).click();
      const frame = page.locator(".prototype-frame");
      await expect(frame).toBeVisible();
      await expect.poll(async () => {
        const bounds = await frame.boundingBox();
        return bounds ? { width: Math.round(bounds.width), height: Math.round(bounds.height) } : null;
      }).toEqual({ width: fixture.width, height: fixture.height });
      await waitForDeterministicPaint(page);

      await expect(frame).toHaveScreenshot(`${kind}.png`, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        threshold: 0.12,
        maxDiffPixelRatio: 0.001,
      });
    });
  }
});
