import { defineConfig } from "playwright/test";

const configuredChannel = process.env.FORMASPEC_E2E_BROWSER_CHANNEL?.trim();
const browserChannel = configuredChannel || (process.platform === "darwin" ? "chrome" : undefined);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "product-manager-backup-restore.spec.ts",
  outputDir: "../../test-results/product-manager-backup-restore",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    viewport: { width: 1_600, height: 1_400 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    serviceWorkers: "block",
    actionTimeout: 12_000,
    navigationTimeout: 25_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text"],
    },
  },
  projects: [{ name: "chrome-release-scenario" }],
});

