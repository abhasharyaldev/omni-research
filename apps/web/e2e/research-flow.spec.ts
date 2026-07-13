import { expect, test } from "@playwright/test";

/**
 * Full user journey against a running local stack (pnpm dev + fixture server):
 * register → create project (fixture URLs) → run real crawl → live progress →
 * report with verified citations → open a citation → export.
 *
 * Start the fixture site first:  pnpm tsx fixtures/serve-fixtures.ts
 */
const FIXTURE_BASE = process.env.E2E_FIXTURE_BASE ?? "http://127.0.0.1:4799";

test.describe.configure({ mode: "serial" });

const email = `e2e-${Date.now()}@local.test`;

test("register a new account", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Display name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/Password/).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/dashboard/);
});

test("create a project with fixture sources and run research", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/dashboard/);

  await page.goto("/projects/new");
  await page.getByPlaceholder(/Research the causes/).fill("Research spaced repetition and learning science.");
  await page
    .getByPlaceholder(/example.org\/article/)
    .fill(`${FIXTURE_BASE}/articles/spaced-repetition.html\n${FIXTURE_BASE}/articles/learning-science.html`);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/projects\//);

  await page.getByRole("button", { name: "Start research run" }).click();
  await expect(page).toHaveURL(/runs\//);

  // Live progress reflects real stages; wait for completion.
  await expect(page.getByText("completed", { exact: false }).first()).toBeVisible({ timeout: 110_000 });

  await page.getByRole("link", { name: "Open report" }).click();
  await expect(page.getByText("citations verified")).toBeVisible();

  // Open the first citation marker and confirm the excerpt drawer.
  const marker = page.locator(".citation-marker").first();
  await marker.click();
  await expect(page.getByText("Supporting excerpt")).toBeVisible();
});
