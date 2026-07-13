/**
 * Crawlee setup: clone the OFFICIAL apify/crawlee repository, verify its
 * origin, pin the release tag matching the installed npm package, record the
 * exact commit hash, verify required exports, and run a local test crawl.
 *
 * Strategy (documented in docs/architecture.md):
 *   1. The runtime dependency is the official `crawlee` npm package, pinned in
 *      the lockfile. npm packages for Crawlee are published from the official
 *      GitHub repository by Apify.
 *   2. The GitHub clone in vendor/crawlee is kept for version verification and
 *      source auditing: the pinned tag must exist in the official repo and
 *      match the installed package version exactly.
 *
 * Usage: pnpm setup:crawlee
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OFFICIAL_REPO = "https://github.com/apify/crawlee";
const OFFICIAL_REPO_GIT = `${OFFICIAL_REPO}.git`;
const ROOT = process.cwd();
const VENDOR_DIR = path.join(ROOT, "vendor", "crawlee");
const VERSION_FILE = path.join(ROOT, "vendor", "crawlee-version.json");

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

function fail(message: string): never {
  console.error(`\n❌ Crawlee setup FAILED: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("OmniResearch — Crawlee setup\n");

  // 1. Git installed?
  try {
    const version = await git(["--version"]);
    console.log(`✓ Git available: ${version}`);
  } catch {
    fail("Git is not installed or not on PATH. Install Git and retry.");
  }

  // 2. Installed npm package version (the actual runtime dependency).
  const pkgPath = path.join(ROOT, "node_modules", "crawlee", "package.json");
  if (!existsSync(pkgPath)) {
    fail('The "crawlee" npm package is not installed yet. Run "pnpm install" first.');
  }
  const installed = JSON.parse(await readFile(pkgPath, "utf8")) as { name: string; version: string };
  console.log(`✓ Installed npm package: ${installed.name}@${installed.version}`);

  // 3. Resolve the matching release tag from the OFFICIAL repository without
  //    trusting any local state (ls-remote hits GitHub directly).
  const wantedTag = `v${installed.version}`;
  console.log(`… Resolving tag ${wantedTag} from ${OFFICIAL_REPO_GIT}`);
  const remoteTags = await git(["ls-remote", "--tags", OFFICIAL_REPO_GIT]);
  const tagLine = remoteTags
    .split("\n")
    .find((line) => line.endsWith(`refs/tags/${wantedTag}`) || line.endsWith(`refs/tags/${wantedTag}^{}`));
  if (!tagLine) {
    fail(
      `Tag ${wantedTag} was not found in the official repository. ` +
        "The installed package version must correspond to an official release tag."
    );
  }
  // Prefer the peeled commit (^{}) when present — that's the actual commit.
  const peeled = remoteTags
    .split("\n")
    .find((line) => line.endsWith(`refs/tags/${wantedTag}^{}`));
  const commit = (peeled ?? tagLine).split("\t")[0]!;
  console.log(`✓ Official release tag ${wantedTag} → commit ${commit}`);

  // 4. Clone (or update) the official repository, pinned to that tag.
  await mkdir(path.dirname(VENDOR_DIR), { recursive: true });
  if (!existsSync(path.join(VENDOR_DIR, ".git"))) {
    console.log(`… Cloning ${OFFICIAL_REPO_GIT} at ${wantedTag} (shallow) into vendor/crawlee`);
    await git(["clone", "--depth", "1", "--branch", wantedTag, OFFICIAL_REPO_GIT, VENDOR_DIR]);
  } else {
    console.log("… vendor/crawlee exists; fetching the pinned tag");
    await git(["fetch", "--depth", "1", "origin", `refs/tags/${wantedTag}:refs/tags/${wantedTag}`], VENDOR_DIR);
    await git(["checkout", `tags/${wantedTag}`], VENDOR_DIR);
  }

  // 5. Verify the clone's origin is EXACTLY the official repository.
  const origin = await git(["remote", "get-url", "origin"], VENDOR_DIR);
  const normalizedOrigin = origin.replace(/\.git$/, "");
  if (normalizedOrigin !== OFFICIAL_REPO) {
    fail(`vendor/crawlee origin is "${origin}" — expected ${OFFICIAL_REPO_GIT}. Delete vendor/crawlee and re-run.`);
  }
  console.log(`✓ Clone origin verified: ${origin}`);

  // 6. Verify the checked-out commit matches the remote tag commit.
  const headCommit = await git(["rev-parse", "HEAD"], VENDOR_DIR);
  if (headCommit !== commit) {
    fail(`Checked-out commit ${headCommit} does not match official tag commit ${commit}.`);
  }
  console.log(`✓ Pinned commit verified: ${headCommit}`);

  // 7. Verify required exports from the installed package.
  const crawlee = await import("crawlee");
  const required = ["CheerioCrawler", "PlaywrightCrawler", "RequestQueue", "Configuration"];
  for (const name of required) {
    if (!(name in crawlee)) fail(`Installed crawlee package is missing required export "${name}".`);
  }
  console.log(`✓ Required exports present: ${required.join(", ")}`);

  // 8. Record the pin.
  await writeFile(
    VERSION_FILE,
    JSON.stringify(
      {
        repository: OFFICIAL_REPO,
        tag: wantedTag,
        commit,
        packageVersion: installed.version,
        retrievedAt: new Date().toISOString(),
        installationMethod:
          "official npm package `crawlee` pinned via pnpm-lock.yaml; GitHub clone at the matching release tag kept in vendor/crawlee for origin verification and source auditing",
      },
      null,
      2
    ) + "\n"
  );
  console.log(`✓ Recorded pin in vendor/crawlee-version.json`);

  // 9. Local test crawl against an in-process fixture server.
  console.log("… Running local fixture crawl");
  const { runFixtureCrawl } = await import("./lib/fixture-crawl.js");
  const result = await runFixtureCrawl();
  if (!result.ok) fail(`Local test crawl failed: ${result.detail}`);
  console.log(`✓ Local fixture crawl succeeded: ${result.detail}`);

  console.log("\n✅ Crawlee setup complete.");
  console.log(`   repository: ${OFFICIAL_REPO}`);
  console.log(`   tag:        ${wantedTag}`);
  console.log(`   commit:     ${commit}`);
}

main().catch((err) => fail(err.message ?? String(err)));
