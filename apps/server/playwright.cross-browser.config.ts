import { defineConfig } from "playwright/test";

const host = "127.0.0.1";
const port = 4323;
const baseURL = `http://${host}:${port}`;
const nodeCommand = JSON.stringify(process.execPath);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/selection-alignment-cross-browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1_600, height: 1_200 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    serviceWorkers: "block",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `${nodeCommand} dist/index.js`,
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      APP_MODE: "local",
      HOST: host,
      PORT: String(port),
      PUBLIC_BASE_URL: baseURL,
      DATA_DIR: "/tmp/formaspec-playwright-cross-browser",
      DESIGNER_DATABASE_PATH: ":memory:",
      AUTH_MODE: "none",
      DESIGNER_LOG_LEVEL: "silent",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    },
  },
  projects: [
    { name: "firefox-dpr-1", use: { browserName: "firefox" } },
    { name: "webkit-dpr-1", use: { browserName: "webkit" } },
  ],
});
