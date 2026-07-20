import { defineConfig } from "playwright/test";

const host = "127.0.0.1";
const port = 4317;
const baseURL = `http://${host}:${port}`;
const browserChannel = process.env.FORMASPEC_E2E_BROWSER_CHANNEL
  ?? (process.platform === "darwin" ? "chrome" : undefined);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/selection-alignment",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    browserName: "chromium",
    ...(browserChannel ? { channel: browserChannel } : {}),
    headless: true,
    viewport: { width: 1_600, height: 1_200 },
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
      DATA_DIR: "/tmp/formaspec-playwright-alignment",
      DESIGNER_DATABASE_PATH: ":memory:",
      AUTH_MODE: "none",
      DESIGNER_LOG_LEVEL: "silent",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    },
  },
  projects: [
    { name: "chromium-dpr-1", use: { deviceScaleFactor: 1 } },
    { name: "chromium-dpr-2", use: { deviceScaleFactor: 2 } },
  ],
});
