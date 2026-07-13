import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests. Requirements:
 *   pnpm exec playwright install chromium
 *   API + worker + web running (pnpm dev) with a reachable database.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
});
