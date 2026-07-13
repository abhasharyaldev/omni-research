import { sha256Hex, type CrawlLimits, type ResearchRequestData } from "@omni/shared";
import { validateUrlResolved, validateUrlSyntax, type UrlPolicy } from "@omni/security";
import { load } from "cheerio";
import type { CrawlEvent, CrawlTask, FailedPage, RetrievedPage, SkippedPage } from "../crawler-types.js";
import type { RobotsPolicy } from "../robots-policy.js";
import { extractContent } from "../content-extractor.js";
import { extractMetadata } from "../metadata-extractor.js";

export type PlaywrightAvailability = { available: true } | { available: false; reason: string };

/**
 * Playwright is an optional escalation path. Detect real availability
 * (package installed AND a browser binary downloaded) without crashing.
 */
export async function playwrightAvailability(): Promise<PlaywrightAvailability> {
  try {
    // Computed specifier: playwright is an OPTIONAL dependency; a static
    // import would fail typechecking when it isn't installed.
    const moduleName = "playwright";
    const { chromium } = (await import(moduleName)) as any;
    const executable = chromium.executablePath();
    const { existsSync } = await import("node:fs");
    if (!executable || !existsSync(executable)) {
      return {
        available: false,
        reason: "Chromium browser not downloaded. Run: pnpm exec playwright install chromium",
      };
    }
    return { available: true };
  } catch {
    return {
      available: false,
      reason: "playwright package not installed. Run: pnpm add -w playwright && pnpm exec playwright install chromium",
    };
  }
}

export type PlaywrightWaveOptions = {
  tasks: CrawlTask[];
  limits: CrawlLimits;
  policy: UrlPolicy;
  userAgent: string;
  robots: RobotsPolicy;
  onEvent?: (event: CrawlEvent) => void;
  shouldCancel?: () => boolean;
  deadline: number;
};

export type PlaywrightWaveResult = {
  retrieved: RetrievedPage[];
  skipped: SkippedPage[];
  failed: FailedPage[];
};

/**
 * Render JS-heavy pages with Crawlee's PlaywrightCrawler. Only called for
 * pages that already passed robots + safety checks in the Cheerio wave; both
 * checks are re-run here anyway, and every subresource request is filtered:
 * only http(s) to non-forbidden hosts, no images/fonts/media downloads.
 */
export async function crawlWithPlaywright(options: PlaywrightWaveOptions): Promise<PlaywrightWaveResult> {
  const { tasks, limits, policy, userAgent, robots, onEvent, shouldCancel, deadline } = options;
  const retrieved: RetrievedPage[] = [];
  const skipped: SkippedPage[] = [];
  const failed: FailedPage[] = [];

  // Imported lazily so environments without Playwright can still use the app.
  const { PlaywrightCrawler, Configuration } = await import("crawlee");

  const crawler = new PlaywrightCrawler(
    {
      maxConcurrency: Math.min(2, limits.maxConcurrency),
      maxRequestRetries: Math.min(1, limits.maxRetries),
      maxRequestsPerCrawl: tasks.length,
      navigationTimeoutSecs: Math.ceil(limits.requestTimeoutMs / 1000),
      requestHandlerTimeoutSecs: Math.ceil(limits.requestTimeoutMs / 1000) + 30,
      launchContext: {
        launchOptions: { headless: true },
        userAgent,
      },
      preNavigationHooks: [
        async ({ request, page }) => {
          if (shouldCancel?.() || Date.now() > deadline) {
            throw new Error("SKIP[cancelled]: Run cancelled or out of time");
          }
          const verdict = await validateUrlResolved(request.url, policy);
          if (!verdict.ok) throw new Error(`SKIP[private-network]: ${verdict.detail}`);
          const robotsDecision = await robots.check(request.url);
          if (!robotsDecision.allowed) {
            throw new Error(`SKIP[robots-disallowed]: ${robotsDecision.reason}`);
          }
          await page.route("**/*", (route) => {
            const req = route.request();
            const type = req.resourceType();
            if (["image", "media", "font"].includes(type)) return route.abort();
            const target = validateUrlSyntax(req.url(), policy);
            if (!target.ok) return route.abort();
            return route.continue();
          });
        },
      ],
      requestHandler: async ({ request, page, response }) => {
        const finalUrl = page.url();
        const finalVerdict = validateUrlSyntax(finalUrl, policy);
        if (!finalVerdict.ok) throw new Error(`SKIP[redirect-blocked]: ${finalVerdict.detail}`);
        const status = response?.status() ?? 0;
        if (status === 401 || status === 403) {
          throw new Error(`SKIP[login-required]: HTTP ${status} — access restricted, not bypassed`);
        }
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        const html = await page.content();
        if (Buffer.byteLength(html) > limits.maxResponseBytes) {
          throw new Error(`SKIP[response-too-large]: rendered DOM exceeds size limit`);
        }
        const $ = load(html);
        const metadata = extractMetadata($, finalUrl);
        const content = extractContent(html, finalUrl);
        retrieved.push({
          requestedUrl: request.url,
          finalUrl,
          canonicalUrl: metadata.canonicalUrl,
          userData: request.userData as ResearchRequestData,
          status,
          contentType: "text/html",
          crawlMethod: "playwright",
          retrievedAt: new Date(),
          metadata,
          mainText: content.mainText,
          headings: content.headings,
          wordCount: content.wordCount,
          contentHash: sha256Hex(content.mainText.toLowerCase().replace(/\s+/g, " ").trim()),
          outboundLinks: content.outboundLinks,
          rawHtmlBytes: Buffer.byteLength(html),
          paywallSuspected: content.paywallSuspected,
          loginSuspected: content.loginSuspected,
        });
        onEvent?.({ kind: "retrieved", url: request.url, finalUrl, wordCount: content.wordCount });
      },
      failedRequestHandler: ({ request }, error) => {
        const message = (error as Error).message ?? "unknown";
        const match = message.match(/SKIP\[([a-z-]+)\]: ([\s\S]*)/);
        if (match) {
          skipped.push({
            url: request.url,
            userData: request.userData as ResearchRequestData,
            reason: match[1] as SkippedPage["reason"],
            detail: match[2]!.slice(0, 500),
          });
        } else {
          failed.push({
            url: request.url,
            userData: request.userData as ResearchRequestData,
            error: message.slice(0, 500),
            retries: request.retryCount,
          });
        }
        onEvent?.({ kind: "failed", url: request.url, error: message.slice(0, 200) });
      },
    },
    new Configuration({ persistStorage: false })
  );

  await crawler.run(tasks.map((t) => ({ url: t.url, userData: t.userData })));
  return { retrieved, skipped, failed };
}
