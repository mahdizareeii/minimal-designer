import { defineConfig } from "playwright/test";

const host = "127.0.0.1";
const port = 4318;
const baseURL = `http://${host}:${port}`;
const configuredChannel = process.env.FORMASPEC_E2E_BROWSER_CHANNEL?.trim();
const browserChannel = configuredChannel || (process.platform === "darwin" ? "chrome" : undefined);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/visual-regression",
  snapshotPathTemplate: "{testDir}/visual-regression-snapshots/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    viewport: { width: 1_600, height: 1_400 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    serviceWorkers: "block",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text"],
    },
  },
  webServer: {
    command: "node dist/index.js",
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      APP_MODE: "local",
      HOST: host,
      PORT: String(port),
      PUBLIC_BASE_URL: baseURL,
      DATA_DIR: "/tmp/formaspec-playwright-visual",
      DESIGNER_DATABASE_PATH: ":memory:",
      AUTH_MODE: "none",
      DESIGNER_LOG_LEVEL: "silent",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    },
  },
  projects: [{ name: "chrome-dpr-1", use: { deviceScaleFactor: 1 } }],
});
