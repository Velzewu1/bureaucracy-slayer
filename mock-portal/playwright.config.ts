import { defineConfig } from "@playwright/test";

// Self-contained e2e config: serves this portal's production build only and never touches the
// main project. A static build avoids dev-server cold-start flakiness under parallel workers.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  workers: 4,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5180", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://127.0.0.1:5180/dashboard",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
