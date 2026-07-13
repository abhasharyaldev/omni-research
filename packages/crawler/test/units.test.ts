import { describe, expect, it } from "vitest";
import { load } from "cheerio";
import { formatCitation } from "../src/citation-builder.js";
import { groupDuplicates } from "../src/duplicate-detector.js";
import { classifySource } from "../src/source-classifier.js";
import { extractContent } from "../src/content-extractor.js";
import { extractMetadata } from "../src/metadata-extractor.js";
import { DomainRateLimiter } from "../src/domain-rate-limiter.js";
import type { RetrievedPage } from "../src/crawler-types.js";

function page(overrides: Partial<RetrievedPage>): RetrievedPage {
  return {
    requestedUrl: "https://example.com/a",
    finalUrl: "https://example.com/a",
    userData: {
      projectId: "p",
      researchRunId: "r",
      topicId: "t",
      depth: 0,
      priority: 0,
      discoveredBy: "user",
    },
    status: 200,
    contentType: "text/html",
    crawlMethod: "cheerio",
    retrievedAt: new Date("2026-07-01T00:00:00Z"),
    metadata: {},
    mainText: "",
    headings: [],
    wordCount: 0,
    contentHash: "h",
    outboundLinks: [],
    paywallSuspected: false,
    loginSuspected: false,
    ...overrides,
  };
}

describe("citation formatting", () => {
  const source = {
    title: "Spaced repetition and long-term retention",
    author: "Dana Okafor",
    publisher: "Learning Research Journal",
    publishedAt: new Date(Date.UTC(2026, 5, 2)),
    retrievedAt: new Date(Date.UTC(2026, 6, 12)),
    url: "https://example.com/a",
  };

  it("formats APA/MLA/Chicago/web", () => {
    expect(formatCitation(source, "apa")).toContain("Okafor, D.");
    expect(formatCitation(source, "apa")).toContain("(2026, June 2)");
    expect(formatCitation(source, "mla")).toContain('"Spaced repetition and long-term retention."');
    expect(formatCitation(source, "chicago")).toContain("Accessed July 12, 2026");
    expect(formatCitation(source, "web")).toContain("https://example.com/a");
  });

  it("labels missing metadata instead of guessing", () => {
    const bare = formatCitation({ retrievedAt: source.retrievedAt, url: source.url }, "apa");
    expect(bare).toContain("[Author unavailable]");
    expect(bare).toContain("(n.d.)");
    const web = formatCitation({ retrievedAt: source.retrievedAt, url: source.url }, "web");
    expect(web).toContain("Author unavailable");
    expect(web).toContain("Publication date unavailable");
  });
});

describe("duplicate detection", () => {
  it("groups identical content hashes and prefers the canonical/earlier page", () => {
    const original = page({
      finalUrl: "https://origin.com/story",
      canonicalUrl: "https://origin.com/story",
      contentHash: "same",
      wordCount: 500,
      mainText: "word ".repeat(500),
      metadata: { title: "Story", publishedAt: new Date("2026-01-01") },
    });
    const copy = page({
      requestedUrl: "https://mirror.com/story",
      finalUrl: "https://mirror.com/story",
      contentHash: "same",
      wordCount: 500,
      mainText: "word ".repeat(500),
      metadata: { title: "Story", publishedAt: new Date("2026-01-03") },
    });
    const groups = groupDuplicates([copy, original]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.primary.finalUrl).toBe("https://origin.com/story");
    expect(groups[0]!.duplicates).toHaveLength(1);
  });

  it("groups near-duplicate text with matching titles", () => {
    const base = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i} explains how spaced repetition schedule number ${i} affects student retention outcomes.`
    ).join(" ");
    const a = page({ finalUrl: "https://a.com/x", contentHash: "h1", wordCount: 480, mainText: base, metadata: { title: "Same title" } });
    const b = page({
      finalUrl: "https://b.com/y",
      contentHash: "h2",
      wordCount: 487,
      mainText: base + " A tiny extra syndication footer sentence.",
      metadata: { title: "Same title" },
    });
    expect(groupDuplicates([a, b])).toHaveLength(1);
  });

  it("keeps distinct pages separate", () => {
    const a = page({ finalUrl: "https://a.com/1", contentHash: "h1", mainText: "completely different text about volcanoes ".repeat(30), wordCount: 210 });
    const b = page({ finalUrl: "https://b.com/2", contentHash: "h2", mainText: "unrelated discussion of medieval trade routes ".repeat(30), wordCount: 210 });
    expect(groupDuplicates([a, b])).toHaveLength(2);
  });
});

describe("source classification", () => {
  it("classifies by domain and shows reasons", () => {
    const gov = classifySource(page({ finalUrl: "https://data.census.gov/report", wordCount: 900, mainText: "x ".repeat(900) }));
    expect(gov.classification).toBe("government");
    expect(gov.reasons.length).toBeGreaterThan(0);
    const ugc = classifySource(page({ finalUrl: "https://reddit.com/r/x/post", wordCount: 300 }));
    expect(ugc.classification).toBe("user-generated");
    expect(ugc.qualityScore).toBeLessThan(gov.qualityScore);
  });
});

describe("content + metadata extraction", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>T</title>
    <meta name="author" content="Jane Roe">
    <meta property="article:published_time" content="2026-03-04T10:00:00Z">
    <meta property="og:site_name" content="Site">
    <link rel="canonical" href="/canon">
    </head><body>
    <nav><a href="/nav1">Nav</a></nav>
    <article><h1>Heading One</h1>
    ${"<p>Meaningful paragraph text about the research topic explaining details and evidence for readers. This sentence continues to add sufficient length for extraction thresholds.</p>".repeat(6)}
    <a href="https://other.example.com/ref">Reference</a>
    <a rel="nofollow" href="https://spam.example.com/x">Spam</a>
    </article>
    <footer>Footer boilerplate</footer>
    </body></html>`;

  it("extracts metadata including dates and canonical URL", () => {
    const meta = extractMetadata(load(html), "https://host.example.com/page");
    expect(meta.author).toBe("Jane Roe");
    expect(meta.publishedAt?.toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(meta.canonicalUrl).toBe("https://host.example.com/canon");
    expect(meta.publisher).toBe("Site");
  });

  it("extracts main text and honors nofollow on links", () => {
    const content = extractContent(html, "https://host.example.com/page");
    expect(content.wordCount).toBeGreaterThan(50);
    expect(content.mainText).toContain("Meaningful paragraph text");
    const linkUrls = content.outboundLinks.map((l) => l.url);
    expect(linkUrls).toContain("https://other.example.com/ref");
    expect(linkUrls).not.toContain("https://spam.example.com/x");
    expect(content.headings).toContain("Heading One");
  });

  it("detects paywall/login hints", () => {
    const paywalled = `<html><body><p>Subscribe to continue reading this article.</p></body></html>`;
    const content = extractContent(paywalled, "https://x.com");
    expect(content.paywallSuspected).toBe(true);
  });
});

describe("domain rate limiter", () => {
  it("enforces delay between requests to the same domain", async () => {
    const limiter = new DomainRateLimiter({ defaultDelayMs: 120, maxPerDomainConcurrency: 1 });
    const start = Date.now();
    await limiter.acquire("example.com");
    limiter.release("example.com");
    await limiter.acquire("example.com");
    limiter.release("example.com");
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
  });

  it("applies Retry-After and cools down after repeated failures", () => {
    const limiter = new DomainRateLimiter({ defaultDelayMs: 10, maxPerDomainConcurrency: 2, failureThreshold: 2, cooldownMs: 60_000 });
    limiter.applyRetryAfter("example.com", "30");
    limiter.reportFailure("example.com");
    limiter.reportFailure("example.com");
    expect(limiter.isCoolingDown("example.com")).toBe(true);
    expect(limiter.isCoolingDown("other.com")).toBe(false);
  });
});
