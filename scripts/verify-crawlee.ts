/**
 * Crawlee verification: confirms (without modifying anything)
 *   1. vendor/crawlee-version.json exists and points at the official repo
 *   2. vendor/crawlee's git origin is exactly https://github.com/apify/crawlee
 *   3. the checked-out commit equals the recorded pinned commit
 *   4. the installed npm dependency version matches the pinned tag
 *   5. required classes import successfully
 *   6. a local fixture crawl succeeds (real crawl, no placeholder)
 *
 * Usage: pnpm verify:crawlee
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OFFICIAL_REPO = "https://github.com/apify/crawlee";
const ROOT = process.cwd();

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "✓" : "❌"} ${name}: ${detail}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("OmniResearch — Crawlee verification\n");

  // 1. Pin file
  const versionFile = path.join(ROOT, "vendor", "crawlee-version.json");
  if (!existsSync(versionFile)) {
    check("pin file", false, "vendor/crawlee-version.json missing — run pnpm setup:crawlee");
    process.exit(1);
  }
  const pin = JSON.parse(await readFile(versionFile, "utf8")) as {
    repository: string;
    tag: string;
    commit: string;
    packageVersion: string;
  };
  check("pin file", pin.repository === OFFICIAL_REPO, `repository=${pin.repository}, tag=${pin.tag}, commit=${pin.commit.slice(0, 12)}…`);

  // 2 + 3. Clone origin & commit
  const vendorDir = path.join(ROOT, "vendor", "crawlee");
  if (!existsSync(path.join(vendorDir, ".git"))) {
    check("vendor clone", false, "vendor/crawlee missing — run pnpm setup:crawlee");
  } else {
    const { stdout: origin } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: vendorDir });
    check("clone origin", origin.trim().replace(/\.git$/, "") === OFFICIAL_REPO, origin.trim());
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: vendorDir });
    check("pinned commit", head.trim() === pin.commit, `HEAD=${head.trim().slice(0, 12)}… expected=${pin.commit.slice(0, 12)}…`);
  }

  // 4. Installed dependency version
  const pkgPath = path.join(ROOT, "node_modules", "crawlee", "package.json");
  if (!existsSync(pkgPath)) {
    check("installed dependency", false, "crawlee npm package not installed");
  } else {
    const installed = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    check(
      "installed dependency",
      installed.version === pin.packageVersion && `v${installed.version}` === pin.tag,
      `crawlee@${installed.version} vs pinned ${pin.tag}`
    );
  }

  // 5. Required imports
  try {
    const crawlee = await import("crawlee");
    const required = ["CheerioCrawler", "PlaywrightCrawler", "RequestQueue", "Configuration"] as const;
    const missing = required.filter((name) => !(name in crawlee));
    check("required exports", missing.length === 0, missing.length === 0 ? required.join(", ") : `missing: ${missing.join(", ")}`);
    // No placeholder implementation: CheerioCrawler must be a real class with a run method.
    const isReal = typeof (crawlee as any).CheerioCrawler === "function" && typeof (crawlee as any).CheerioCrawler.prototype?.run === "function";
    check("no placeholder implementation", isReal, isReal ? "CheerioCrawler.prototype.run is a real function" : "CheerioCrawler looks fake");
  } catch (err) {
    check("required exports", false, (err as Error).message);
  }

  // 6. Fixture crawl
  try {
    const { runFixtureCrawl } = await import("./lib/fixture-crawl.js");
    const result = await runFixtureCrawl();
    check("local fixture crawl", result.ok, result.detail);
  } catch (err) {
    check("local fixture crawl", false, (err as Error).message);
  }

  console.log(failures === 0 ? "\n✅ Crawlee verification passed." : `\n❌ Crawlee verification failed (${failures} check(s)).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ verification crashed:", err.message);
  process.exit(1);
});
