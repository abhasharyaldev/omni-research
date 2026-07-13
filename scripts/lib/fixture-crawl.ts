/**
 * Shared fixture crawl used by setup-crawlee.ts, verify-crawlee.ts, and the
 * setup wizard: serves the local fixture website on 127.0.0.1 and crawls it
 * with the real crawler stack (CheerioCrawler + robots + safety policies).
 */
import path from "node:path";
import { DEFAULT_CRAWL_LIMITS } from "@omni/shared";
import { crawlPages } from "@omni/crawler";
import { startFixtureServer } from "../../fixtures/serve-lib.js";

export async function runFixtureCrawl(): Promise<{ ok: boolean; detail: string }> {
  process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS = "1"; // fixtures run on 127.0.0.1
  const server = await startFixtureServer(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const outcome = await crawlPages({
      tasks: [
        `${base}/articles/spaced-repetition.html`,
        `${base}/articles/learning-science.html`,
        `${base}/private/secret.html`, // robots.txt disallows this — must be skipped
      ].map((url, index) => ({
        url,
        userData: {
          projectId: "fixture",
          researchRunId: "fixture-run",
          topicId: "fixture-topic",
          depth: 0,
          priority: 10 - index,
          discoveredBy: "user" as const,
        },
      })),
      limits: { ...DEFAULT_CRAWL_LIMITS, defaultDelayMs: 0, maxPagesPerRun: 10 },
      policy: {},
      userAgent: "OmniResearchBot/1.0 (fixture-verification)",
      storageDir: path.join(".local-data", "crawlee-fixture"),
      runId: `fixture-${Date.now()}`,
    });

    const retrievedUrls = outcome.retrieved.map((p) => p.finalUrl);
    const robotsSkip = outcome.skipped.find((s) => s.reason === "robots-disallowed");
    if (outcome.retrieved.length < 2) {
      return { ok: false, detail: `expected ≥2 retrieved pages, got ${outcome.retrieved.length}` };
    }
    if (!robotsSkip) {
      return { ok: false, detail: "robots.txt-disallowed page was NOT skipped — robots enforcement broken" };
    }
    const first = outcome.retrieved[0]!;
    if (first.wordCount < 50 || !first.metadata.title) {
      return { ok: false, detail: "content extraction returned too little text or no title" };
    }
    return {
      ok: true,
      detail: `retrieved ${outcome.retrieved.length} pages (${retrievedUrls.map((u) => new URL(u).pathname).join(", ")}), robots-disallowed page skipped correctly`,
    };
  } finally {
    await server.close();
    delete process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS;
  }
}
