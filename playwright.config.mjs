import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 12_000 },
  reporter: [["line"], ["html", { open: "never", outputFolder: "test-results/ux-report" }]],
  outputDir: "test-results/ux-artifacts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    colorScheme: "dark",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "chromium-mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
    {
      name: "firefox-desktop",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
