/**
 * First-run setup wizard: checks the toolchain, verifies Crawlee, prepares the
 * database, detects AI providers, runs a fixture crawl, and (with --demo)
 * generates a small cited demo report. Prints an honest readiness summary —
 * failures are reported as failures.
 *
 * Usage: pnpm setup          (add --demo to also build the demo report)
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const results: [string, string][] = [];
const record = (name: string, value: string) => {
  results.push([name, value]);
  console.log(`  ${name}: ${value}`);
};

async function tryVersion(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000 });
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const demo = process.argv.includes("--demo");
  console.log("OmniResearch — first-run setup\n");

  // 1–3. Toolchain
  console.log("Toolchain:");
  record("Node.js", process.version);
  record("pnpm", (await tryVersion("pnpm", ["--version"])) ?? "NOT FOUND — install from https://pnpm.io");
  record("Git", (await tryVersion("git", ["--version"])) ?? "NOT FOUND — install from https://git-scm.com");

  // 4. Crawlee
  console.log("\nCrawlee:");
  const pinExists = existsSync(path.join(process.cwd(), "vendor", "crawlee-version.json"));
  if (!pinExists) {
    console.log("  Pin missing — running setup:crawlee …");
    await execFileAsync("pnpm", ["setup:crawlee"], { shell: process.platform === "win32", timeout: 600_000 })
      .then(() => record("Crawlee", "Ready (origin verified, version pinned)"))
      .catch((err) => record("Crawlee", `FAILED: ${String(err.message).slice(0, 200)}`));
  } else {
    record("Crawlee", "Pinned (run pnpm verify:crawlee for a full re-check)");
  }

  // 5–7. Database
  console.log("\nDatabase:");
  try {
    const { bootstrapDatabase } = await import("@omni/database");
    const db = await bootstrapDatabase({ migrate: true });
    record("PostgreSQL", `Ready (${db.mode}${db.mode === "embedded" ? ", no Docker needed" : ""})`);
    record("Migrations", "Applied");
    record("Queue", "Ready (database-backed local queue; Redis optional)");
    await db.stop?.();
  } catch (err) {
    record("PostgreSQL", `FAILED: ${(err as Error).message.split("\n")[0]}`);
  }

  // 8–14. Providers
  console.log("\nAI providers:");
  const { getProviderManager } = await import("@omni/ai-providers");
  const manager = getProviderManager();
  for (const report of await manager.statusAll()) {
    record(report.displayName, report.statusCode);
  }
  record("Default provider", manager.defaultId());
  record("Paid API keys required", "No");

  // 15. Fixture crawl
  console.log("\nVerification:");
  try {
    const { runFixtureCrawl } = await import("./lib/fixture-crawl.js");
    const crawl = await runFixtureCrawl();
    record("Fixture crawl", crawl.ok ? "Passed" : `FAILED: ${crawl.detail}`);
  } catch (err) {
    record("Fixture crawl", `FAILED: ${(err as Error).message.slice(0, 200)}`);
  }

  // 16. Demo report
  if (demo) {
    try {
      await execFileAsync("pnpm", ["db:seed", "--", "--run"], {
        shell: process.platform === "win32",
        timeout: 600_000,
      });
      record("Demo cited report", "Generated (sign in as demo@omniresearch.local)");
    } catch (err) {
      record("Demo cited report", `FAILED: ${String((err as Error).message).slice(0, 200)}`);
    }
  }

  // 17. Summary
  console.log("\n──────── Readiness summary ────────");
  for (const [name, value] of results) console.log(`${name.padEnd(26)} ${value}`);
  const failed = results.filter(([, v]) => v.includes("FAILED") || v.includes("NOT FOUND"));
  console.log(failed.length === 0 ? "\n✅ Setup complete. Run: pnpm dev" : `\n⚠ ${failed.length} item(s) need attention (see above).`);
}

main().catch((err) => {
  console.error("setup wizard crashed:", err.message);
  process.exit(1);
});
