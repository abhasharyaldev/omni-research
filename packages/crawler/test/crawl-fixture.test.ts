import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { DEFAULT_CRAWL_LIMITS } from "@omni/shared";
import { crawlPages } from "../src/crawler-manager.js";
import { fetchFeed } from "../src/rss-extractor.js";
import { fetchSitemap } from "../src/sitemap-extractor.js";
import { RobotsPolicy } from "../src/robots-policy.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/serve-lib.js";
import type { ResearchRequestData } from "@omni/shared";

let server: FixtureServer;
let base: string;

const userData = (priority = 0): ResearchRequestData => ({
  projectId: "p",
  researchRunId: "r",
  topicId: "t",
  depth: 0,
  priority,
  discoveredBy: "user",
});

beforeAll(async () => {
  process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS = "1";
  server = await startFixtureServer(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  delete process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS;
});

const limits = { ...DEFAULT_CRAWL_LIMITS, defaultDelayMs: 0, requestTimeoutMs: 15_000 };

describe("crawlPages against the local fixture site (real Crawlee)", () => {
  it("retrieves pages, extracts content, and enforces robots.txt", async () => {
    const outcome = await crawlPages({
      tasks: [
        { url: `${base}/articles/spaced-repetition.html`, userData: userData(3) },
        { url: `${base}/articles/learning-science.html`, userData: userData(2) },
        { url: `${base}/private/secret.html`, userData: userData(1) },
      ],
      limits,
      policy: {},
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-crawlee"),
      runId: `t-${Date.now()}`,
    });

    expect(outcome.retrieved).toHaveLength(2);
    const first = outcome.retrieved.find((p) => p.finalUrl.includes("spaced-repetition"))!;
    expect(first.metadata.title).toContain("Spaced repetition");
    expect(first.metadata.author).toBe("Dana Okafor");
    expect(first.wordCount).toBeGreaterThan(100);
    expect(first.mainText).toContain("Ebbinghaus");
    expect(first.outboundLinks.length).toBeGreaterThan(0);

    const robotsSkip = outcome.skipped.find((s) => s.reason === "robots-disallowed");
    expect(robotsSkip?.url).toContain("/private/secret");
    // The private page's content must never appear anywhere.
    expect(outcome.retrieved.every((p) => !p.mainText.includes("Private page"))).toBe(true);
  }, 60_000);

  it("blocks internal/unsafe URLs before any request is made", async () => {
    const outcome = await crawlPages({
      tasks: [
        { url: "http://10.0.0.1/internal", userData: userData() },
        { url: "http://169.254.169.254/latest/meta-data/", userData: userData() },
        { url: "file:///etc/passwd", userData: userData() },
        { url: "http://localhost:8080/admin", userData: userData() },
      ],
      limits,
      policy: {},
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-crawlee"),
      runId: `t-${Date.now()}`,
    });
    expect(outcome.retrieved).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(4);
    for (const skip of outcome.skipped) {
      expect(["private-network", "unsafe-url", "domain-blocked"]).toContain(skip.reason);
    }
  }, 30_000);

  it("blocks redirects into forbidden networks", async () => {
    const outcome = await crawlPages({
      tasks: [{ url: `${base}/redirect-to-internal`, userData: userData() }],
      limits,
      policy: {},
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-crawlee"),
      runId: `t-${Date.now()}`,
    });
    expect(outcome.retrieved).toHaveLength(0);
    // Recorded as skipped (redirect-blocked) or failed — never retrieved.
    const all = [...outcome.skipped.map((s) => s.reason as string), ...outcome.failed.map(() => "failed")];
    expect(all.length).toBeGreaterThan(0);
  }, 30_000);

  it("enforces per-run and per-domain page limits and deduplicates URLs", async () => {
    const outcome = await crawlPages({
      tasks: [
        { url: `${base}/articles/spaced-repetition.html`, userData: userData(5) },
        { url: `${base}/articles/spaced-repetition.html?utm_source=x`, userData: userData(4) }, // dup after normalization
        { url: `${base}/articles/learning-science.html`, userData: userData(3) },
        { url: `${base}/articles/injection-attempt.html`, userData: userData(2) },
        { url: `${base}/index.html`, userData: userData(1) },
      ],
      limits: { ...limits, maxPagesPerDomain: 2, maxPagesPerRun: 2 },
      policy: {},
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-crawlee"),
      runId: `t-${Date.now()}`,
    });
    expect(outcome.retrieved.length).toBeLessThanOrEqual(2);
    expect(outcome.skipped.some((s) => s.reason === "duplicate-url")).toBe(true);
    expect(outcome.skipped.some((s) => s.reason === "crawl-limit-reached")).toBe(true);
  }, 60_000);

  it("honors domain blocklists", async () => {
    const outcome = await crawlPages({
      tasks: [{ url: `${base}/articles/spaced-repetition.html`, userData: userData() }],
      limits,
      policy: { blockDomains: ["127.0.0.1"] },
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-crawlee"),
      runId: `t-${Date.now()}`,
    });
    expect(outcome.retrieved).toHaveLength(0);
  }, 30_000);
});

describe("feed and sitemap extraction (SSRF-safe fetch path)", () => {
  it("parses the RSS feed", async () => {
    const feed = await fetchFeed(`${base}/feed.xml`);
    expect(feed.feedTitle).toBe("Learning Research Journal");
    expect(feed.items).toHaveLength(3);
    expect(feed.items[0]!.publishedAt).toBeInstanceOf(Date);
  });

  it("parses the sitemap", async () => {
    const sitemap = await fetchSitemap(`${base}/sitemap.xml`);
    expect(sitemap.entries).toHaveLength(3);
    expect(sitemap.entries[0]!.url).toContain("/articles/");
  });
});

describe("robots policy", () => {
  it("answers allow/deny from the fixture robots.txt", async () => {
    const robots = new RobotsPolicy("OmniResearchBot/1.0-test");
    const allowed = await robots.check(`${base}/articles/spaced-repetition.html`);
    expect(allowed.allowed).toBe(true);
    const denied = await robots.check(`${base}/private/secret.html`);
    expect(denied.allowed).toBe(false);
  });
});
