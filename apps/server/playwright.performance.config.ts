import { defineConfig } from "playwright/test";

const host = "127.0.0.1";
const port = 4319;
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: "./performance",
  testMatch: "browser-performance.spec.ts",
  outputDir: "../../test-results/browser-performance",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1_600, height: 1_200 },
    deviceScaleFactor: 1,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
      DATA_DIR: `/tmp/formaspec-playwright-performance-${process.pid}`,
      DESIGNER_DATABASE_PATH: ":memory:",
      AUTH_MODE: "none",
      DESIGNER_LOG_LEVEL: "silent",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "false",
      FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
      FORMASPEC_RENDER_TIMEOUT_MS: "15000",
      FORMASPEC_RENDER_CONCURRENCY: "1",
      FORMASPEC_RENDER_QUEUE_LIMIT: "2",
    },
  },
  projects: [{ name: "pinned-chromium-dpr-1" }],
});
