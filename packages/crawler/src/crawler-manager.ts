import { CheerioCrawler, Configuration, log as crawleeLog, LogLevel } from "crawlee";
import { load } from "cheerio";
import { sha256Hex, type ResearchRequestData, type SkipReason } from "@omni/shared";
import { guardedLookup, validateUrlResolved, validateUrlSyntax } from "@omni/security";
import type {
  CrawlEvent,
  CrawlOptions,
  CrawlOutcome,
  CrawlTask,
  FailedPage,
  RetrievedPage,
  SkippedPage,
} from "./crawler-types.js";
import { SkipError, asSkip } from "./crawl-errors.js";
import { RobotsPolicy } from "./robots-policy.js";
import { DomainRateLimiter } from "./domain-rate-limiter.js";
import { extractContent } from "./content-extractor.js";
import { extractMetadata } from "./metadata-extractor.js";
import {
  domainOf,
  hasForbiddenExtension,
  looksLikePdf,
  normalizeUrl,
} from "./url-normalizer.js";
import { fetchPdf } from "./pdf-extractor.js";
import { crawlWithPlaywright, playwrightAvailability } from "./crawlers/playwright-crawler.js";
import { extractVideoSource, isVideoUrl } from "./video-source.js";

crawleeLog.setLevel(LogLevel.OFF);

const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/**
 * Crawl a single wave of pages with Crawlee's CheerioCrawler, enforcing:
 * robots.txt, layered SSRF validation (pre-queue, connect-time DNS guard,
 * per-redirect-hop, post-response), per-run/per-domain page caps, response
 * size caps, total download caps, run duration, retries, and politeness
 * delays. PDFs are routed to the PDF extractor. Pages that look JS-rendered
 * can optionally be retried through Playwright.
 */
export async function crawlPages(options: CrawlOptions): Promise<CrawlOutcome> {
  const { tasks, limits, policy, userAgent, onEvent, shouldCancel } = options;

  const retrieved: RetrievedPage[] = [];
  const skipped: SkippedPage[] = [];
  const failed: FailedPage[] = [];
  const domainCounts = new Map<string, number>();
  const seenUrls = new Set<string>();
  let totalBytes = 0;
  let cancelled = false;

  const robots = new RobotsPolicy(userAgent, policy);
  const limiter = new DomainRateLimiter({
    defaultDelayMs: limits.defaultDelayMs,
    maxPerDomainConcurrency: 2,
  });

  const emit = (event: CrawlEvent) => onEvent?.(event);
  const recordSkip = (url: string, reason: SkipReason, detail: string, userData?: ResearchRequestData) => {
    skipped.push({ url, userData, reason, detail: detail.slice(0, 500) });
    emit({ kind: "skipped", url, reason, detail: detail.slice(0, 200) });
  };

  // ---- Pre-queue validation & routing -------------------------------------
  const htmlTasks: CrawlTask[] = [];
  const pdfTasks: CrawlTask[] = [];
  const videoTasks: CrawlTask[] = [];

  for (const task of tasks) {
    const normalized = normalizeUrl(task.url);
    if (!normalized) {
      recordSkip(task.url, "unsafe-url", "URL could not be parsed/normalized", task.userData);
      continue;
    }
    if (seenUrls.has(normalized)) {
      recordSkip(task.url, "duplicate-url", "Duplicate of an already-queued URL", task.userData);
      continue;
    }
    if (hasForbiddenExtension(normalized)) {
      recordSkip(task.url, "unsupported-content-type", "Executable/archive extensions are never downloaded", task.userData);
      continue;
    }
    const syntax = validateUrlSyntax(normalized, policy);
    if (!syntax.ok) {
      const reason: SkipReason =
        syntax.reason === "domain-blocked" || syntax.reason === "not-in-allowlist"
          ? "domain-blocked"
          : syntax.reason === "forbidden-ip" || syntax.reason === "forbidden-hostname"
            ? "private-network"
            : "unsafe-url";
      recordSkip(task.url, reason, syntax.detail, task.userData);
      continue;
    }
    if (retrievedPlanned() >= limits.maxPagesPerRun) {
      recordSkip(task.url, "crawl-limit-reached", `Run page limit ${limits.maxPagesPerRun} reached`, task.userData);
      continue;
    }
    const domain = domainOf(normalized);
    // Video-platform URLs are not HTML-crawled; they are "watched" — routed to
    // the video transcript extractor below and returned as video RetrievedPages.
    if (isVideoUrl(normalized)) {
      seenUrls.add(normalized);
      videoTasks.push({ url: normalized, userData: task.userData });
      emit({ kind: "queued", url: normalized });
      continue;
    }
    const planned = (domainCounts.get(domain) ?? 0) + 1;
    if (planned > limits.maxPagesPerDomain) {
      recordSkip(task.url, "crawl-limit-reached", `Domain page limit ${limits.maxPagesPerDomain} reached for ${domain}`, task.userData);
      continue;
    }
    domainCounts.set(domain, planned);
    seenUrls.add(normalized);
    const routed: CrawlTask = { url: normalized, userData: task.userData };
    if (looksLikePdf(normalized)) pdfTasks.push(routed);
    else htmlTasks.push(routed);
    emit({ kind: "queued", url: normalized });
  }

  function retrievedPlanned(): number {
    return seenUrls.size;
  }

  const deadline = Date.now() + limits.maxRunDurationMs;

  // ---- PDF route ----------------------------------------------------------
  for (const task of pdfTasks) {
    if (shouldCancel?.() || Date.now() > deadline) {
      cancelled = cancelled || Boolean(shouldCancel?.());
      recordSkip(task.url, cancelled ? "cancelled" : "crawl-limit-reached", cancelled ? "Run cancelled" : "Run duration limit reached", task.userData);
      continue;
    }
    const domain = domainOf(task.url);
    const robotsDecision = await robots.check(task.url);
    emit({ kind: "robots-check", url: task.url, allowed: robotsDecision.allowed });
    if (!robotsDecision.allowed) {
      recordSkip(task.url, "robots-disallowed", robotsDecision.reason, task.userData);
      continue;
    }
    if (robotsDecision.crawlDelaySeconds) limiter.applyCrawlDelay(domain, robotsDecision.crawlDelaySeconds);
    await limiter.acquire(domain);
    emit({ kind: "crawling", url: task.url, domain });
    try {
      const page = await fetchPdf(task.url, task.userData, {
        policy,
        userAgent,
        timeoutMs: limits.requestTimeoutMs,
        maxBytes: Math.min(limits.maxResponseBytes * 2, 25_000_000),
      });
      totalBytes += page.mainText.length;
      retrieved.push(page);
      limiter.reportSuccess(domain);
      emit({ kind: "retrieved", url: task.url, finalUrl: page.finalUrl, wordCount: page.wordCount });
    } catch (err) {
      limiter.reportFailure(domain);
      failed.push({ url: task.url, userData: task.userData, error: (err as Error).message.slice(0, 500), retries: 0 });
      emit({ kind: "failed", url: task.url, error: (err as Error).message.slice(0, 200) });
    } finally {
      limiter.release(domain);
    }
  }

  // ---- Video route (transcript extraction, not HTML crawl) ----------------
  for (const task of videoTasks) {
    if (shouldCancel?.() || Date.now() > deadline) {
      cancelled = cancelled || Boolean(shouldCancel?.());
      recordSkip(task.url, cancelled ? "cancelled" : "crawl-limit-reached", cancelled ? "Run cancelled" : "Run duration limit reached", task.userData);
      continue;
    }
    emit({ kind: "crawling", url: task.url, domain: domainOf(task.url) });
    // Bound each extraction by the remaining run duration via an abort signal.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
    let outcome;
    try {
      outcome = await extractVideoSource(task, { policy, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if ("retrieved" in outcome) {
      totalBytes += Buffer.byteLength(outcome.retrieved.mainText);
      retrieved.push(outcome.retrieved);
      emit({ kind: "retrieved", url: task.url, finalUrl: outcome.retrieved.finalUrl, wordCount: outcome.retrieved.wordCount });
    } else if ("skipped" in outcome) {
      skipped.push(outcome.skipped);
      emit({ kind: "skipped", url: task.url, reason: outcome.skipped.reason, detail: outcome.skipped.detail.slice(0, 200) });
    } else {
      failed.push(outcome.failed);
      emit({ kind: "failed", url: task.url, error: outcome.failed.error.slice(0, 200) });
    }
  }

  // ---- HTML route (Crawlee CheerioCrawler) --------------------------------
  const jsRenderedCandidates: CrawlTask[] = [];

  if (htmlTasks.length > 0) {
    const config = new Configuration({
      persistStorage: false,
      storageClientOptions: { localDataDirectory: options.storageDir },
    });

    const crawler: CheerioCrawler = new CheerioCrawler(
      {
        maxConcurrency: limits.maxConcurrency,
        minConcurrency: 1,
        maxRequestRetries: limits.maxRetries,
        maxRequestsPerCrawl: limits.maxPagesPerRun,
        navigationTimeoutSecs: Math.ceil(limits.requestTimeoutMs / 1000),
        requestHandlerTimeoutSecs: Math.ceil(limits.requestTimeoutMs / 1000) + 30,
        sameDomainDelaySecs: Math.max(1, Math.ceil(limits.defaultDelayMs / 1000)),
        additionalMimeTypes: ["text/plain"],
        useSessionPool: true,

        preNavigationHooks: [
          async ({ request }, gotOptions) => {
            if (shouldCancel?.()) {
              cancelled = true;
              await stopCrawler();
              throw new SkipError("cancelled", "Run cancelled by user");
            }
            if (Date.now() > deadline) {
              await stopCrawler();
              throw new SkipError("crawl-limit-reached", "Run duration limit reached");
            }
            if (totalBytes > limits.maxTotalBytes) {
              await stopCrawler();
              throw new SkipError("crawl-limit-reached", "Total download limit reached");
            }

            const url = request.url;
            const domain = domainOf(url);

            // Fresh resolved validation right before navigation.
            const verdict = await validateUrlResolved(url, policy);
            emit({ kind: "safety-check", url, allowed: verdict.ok });
            if (!verdict.ok) {
              throw new SkipError(
                verdict.reason === "domain-blocked" || verdict.reason === "not-in-allowlist"
                  ? "domain-blocked"
                  : "private-network",
                verdict.detail
              );
            }

            const robotsDecision = await robots.check(url);
            emit({ kind: "robots-check", url, allowed: robotsDecision.allowed });
            if (!robotsDecision.allowed) {
              throw new SkipError("robots-disallowed", robotsDecision.reason);
            }
            if (robotsDecision.crawlDelaySeconds) {
              limiter.applyCrawlDelay(domain, robotsDecision.crawlDelaySeconds);
            }

            emit({ kind: "crawling", url, domain });

            // got-level hardening: header, redirect cap, per-hop validation,
            // connect-time DNS guard.
            gotOptions.headers = { ...gotOptions.headers, "user-agent": userAgent };
            gotOptions.maxRedirects = limits.maxRedirects;
            (gotOptions as any).dnsLookup = guardedLookup;
            const hooks: any = (gotOptions.hooks ??= {});
            (hooks.beforeRedirect ??= []).push(async (redirectOptions: any) => {
              const target = String(redirectOptions.url ?? "");
              const hop = await validateUrlResolved(target, policy);
              if (!hop.ok) {
                throw new SkipError("redirect-blocked", `Redirect to ${target} blocked: ${hop.detail}`);
              }
            });
          },
        ],

        requestHandler: async ({ request, response, body, contentType }) => {
          const url = request.url;
          const finalUrl = request.loadedUrl ?? url;
          const userData = request.userData as ResearchRequestData;

          // Post-response validation of the final URL (covers any hop we missed).
          const finalVerdict = validateUrlSyntax(finalUrl, policy);
          if (!finalVerdict.ok) {
            throw new SkipError("redirect-blocked", `Final URL rejected: ${finalVerdict.detail}`);
          }

          const status = response.statusCode ?? 0;
          if (status === 429) {
            limiter.applyRetryAfter(domainOf(finalUrl), response.headers["retry-after"] as string | undefined);
            throw new Error(`HTTP 429 from ${finalUrl}`); // retryable
          }
          if (status === 401 || status === 403) {
            throw new SkipError("login-required", `HTTP ${status} — access restricted, not bypassed`);
          }
          if (status >= 400) {
            throw new Error(`HTTP ${status} from ${finalUrl}`);
          }

          const mediaType = contentType.type.toLowerCase();
          if (!HTML_CONTENT_TYPES.some((t) => mediaType.startsWith(t))) {
            throw new SkipError("unsupported-content-type", `Content type ${mediaType} not supported in HTML route`);
          }

          const html = body.toString();
          const byteLength = Buffer.byteLength(html);
          if (byteLength > limits.maxResponseBytes) {
            throw new SkipError("response-too-large", `Response ${byteLength} bytes exceeds limit ${limits.maxResponseBytes}`);
          }
          totalBytes += byteLength;

          const $ = load(html);
          const metadata = extractMetadata($, finalUrl);
          const content = extractContent(html, finalUrl);

          if (content.loginSuspected) {
            throw new SkipError("login-required", "Page content indicates a login wall; not bypassed");
          }

          const page: RetrievedPage = {
            requestedUrl: url,
            finalUrl,
            canonicalUrl: metadata.canonicalUrl,
            userData,
            status,
            contentType: mediaType,
            crawlMethod: "cheerio",
            retrievedAt: new Date(),
            metadata,
            mainText: content.mainText,
            headings: content.headings,
            wordCount: content.wordCount,
            contentHash: sha256Hex(content.mainText.toLowerCase().replace(/\s+/g, " ").trim()),
            outboundLinks: content.outboundLinks,
            rawHtmlBytes: byteLength,
            paywallSuspected: content.paywallSuspected,
            loginSuspected: content.loginSuspected,
          };

          if (content.looksJsRendered && options.allowPlaywrightFallback) {
            jsRenderedCandidates.push({ url: finalUrl, userData });
          }

          retrieved.push(page);
          limiter.reportSuccess(domainOf(finalUrl));
          emit({ kind: "retrieved", url, finalUrl, wordCount: page.wordCount });
        },

        failedRequestHandler: ({ request }, error) => {
          const skip = asSkip(error);
          const userData = request.userData as ResearchRequestData;
          if (skip) {
            recordSkip(request.url, skip.skipReason, skip.detail, userData);
            return;
          }
          limiter.reportFailure(domainOf(request.url));
          failed.push({
            url: request.url,
            userData,
            error: (error as Error).message?.slice(0, 500) ?? "unknown error",
            retries: request.retryCount,
          });
          emit({ kind: "failed", url: request.url, error: (error as Error).message?.slice(0, 200) ?? "unknown" });
        },
      },
      config
    );

    async function stopCrawler(): Promise<void> {
      try {
        // Available in modern Crawlee; gracefully stops accepting new requests.
        (crawler as any).stop?.();
      } catch {
        /* best-effort stop */
      }
    }

    const watchdog = setInterval(() => {
      if (shouldCancel?.() || Date.now() > deadline) {
        cancelled = cancelled || Boolean(shouldCancel?.());
        void stopCrawler();
      }
    }, 1000);
    try {
      await crawler.run(
        htmlTasks.map((task) => ({ url: task.url, userData: task.userData }))
      );
    } finally {
      clearInterval(watchdog);
    }

    // Requests never processed because the crawler stopped early.
    const handled = new Set([
      ...retrieved.map((p) => p.requestedUrl),
      ...skipped.map((s) => s.url),
      ...failed.map((f) => f.url),
    ]);
    for (const task of htmlTasks) {
      if (!handled.has(task.url)) {
        recordSkip(task.url, cancelled ? "cancelled" : "crawl-limit-reached", cancelled ? "Run cancelled before this page was crawled" : "Run stopped before this page was crawled", task.userData);
      }
    }
  }

  // ---- Optional Playwright escalation for JS-rendered pages ----------------
  if (jsRenderedCandidates.length > 0 && options.allowPlaywrightFallback && !cancelled) {
    const availability = await playwrightAvailability();
    if (!availability.available) {
      for (const task of jsRenderedCandidates) {
        // Keep the cheerio result; just note why no escalation happened.
        emit({
          kind: "failed",
          url: task.url,
          error: `Playwright fallback unavailable: ${availability.reason}`,
        });
      }
    } else {
      const escalated = await crawlWithPlaywright({
        tasks: jsRenderedCandidates.slice(0, 10),
        limits,
        policy,
        userAgent,
        robots,
        onEvent,
        shouldCancel,
        deadline,
      });
      for (const page of escalated.retrieved) {
        const existingIndex = retrieved.findIndex((p) => p.finalUrl === page.finalUrl);
        if (existingIndex >= 0 && page.wordCount > (retrieved[existingIndex]?.wordCount ?? 0)) {
          retrieved[existingIndex] = page; // richer render replaces thin HTML
        } else if (existingIndex < 0) {
          retrieved.push(page);
        }
      }
      skipped.push(...escalated.skipped);
      failed.push(...escalated.failed);
    }
  }

  if (shouldCancel?.()) cancelled = true;
  return { retrieved, skipped, failed, totalBytesDownloaded: totalBytes, cancelled };
}
