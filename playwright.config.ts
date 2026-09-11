import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 35_000,
  expect: { timeout: 7_000 },
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:8791",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "npm run build && SESSIONGUARD_ALLOW_LOCAL_INFRA=1 SESSIONGUARD_LOCAL_AUTH_RATE_LIMIT_MAX=100 PLATFORM_DATABASE_PATH=.data/e2e-platform.sqlite LOCAL_KMS_MASTER_KEY=sessionguard-e2e-local-kms-key-over-32-characters DECISION_SIGNING_KEY=sessionguard-e2e-decision-key-over-32-characters APP_ORIGIN=http://127.0.0.1:8791 PORT=8791 npm start",
    url: "http://127.0.0.1:8791/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
