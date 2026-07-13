import type { UrlPolicy } from "@omni/security";
import type { PageLink, SearchInput, SearchProvider, SearchResult } from "./crawler-types.js";
import { fetchFeed } from "./rss-extractor.js";
import { fetchSitemap } from "./sitemap-extractor.js";
import { domainOf, hasForbiddenExtension, normalizeUrl } from "./url-normalizer.js";

/**
 * Keyless source discovery. There is no hidden web-wide search here: the
 * providers below cover user URLs, feeds, sitemaps, and links discovered on
 * approved pages — and each states its coverage honestly so reports can say
 * exactly what was and wasn't searched.
 */

export class ManualUrlProvider implements SearchProvider {
  id = "manual-urls";
  coverage = "Only the URLs the user provided directly.";
  constructor(private urls: string[]) {}
  async search(_input: SearchInput): Promise<SearchResult[]> {
    return this.urls
      .map((url) => normalizeUrl(url))
      .filter((url): url is string => Boolean(url))
      .map((url) => ({ url, title: url, discoveredBy: "user" as const }));
  }
}

export class RssProvider implements SearchProvider {
  id = "rss";
  coverage = "Items from the configured RSS/Atom feeds only.";
  constructor(
    private feedUrls: string[],
    private options: { policy?: UrlPolicy; userAgent?: string } = {}
  ) {}
  async search(input: SearchInput): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    for (const feedUrl of this.feedUrls.slice(0, 20)) {
      try {
        const feed = await fetchFeed(feedUrl, this.options);
        for (const item of feed.items) {
          if (input.dateRangeStart && item.publishedAt && item.publishedAt < input.dateRangeStart) continue;
          if (input.dateRangeEnd && item.publishedAt && item.publishedAt > input.dateRangeEnd) continue;
          results.push({
            url: item.url,
            title: item.title,
            snippet: item.snippet,
            publishedAt: item.publishedAt,
            discoveredBy: "rss",
          });
        }
      } catch {
        // Feed failures are recorded by the caller via missing results; keep going.
      }
    }
    return rankByQuery(results, input);
  }
}

export class SitemapProvider implements SearchProvider {
  id = "sitemap";
  coverage = "URLs listed in the configured XML sitemaps only.";
  constructor(
    private sitemapUrls: string[],
    private options: { policy?: UrlPolicy; userAgent?: string } = {}
  ) {}
  async search(input: SearchInput): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queue = [...this.sitemapUrls.slice(0, 10)];
    let fetched = 0;
    while (queue.length > 0 && fetched < 15) {
      const url = queue.shift()!;
      fetched++;
      try {
        const sitemap = await fetchSitemap(url, this.options);
        queue.push(...sitemap.childSitemaps.slice(0, 5));
        for (const entry of sitemap.entries) {
          results.push({
            url: entry.url,
            title: entry.url,
            publishedAt: entry.lastModified,
            discoveredBy: "sitemap",
          });
        }
      } catch {
        // skip broken sitemap, continue with the rest
      }
    }
    return rankByQuery(results, input).slice(0, input.maxResults ?? 100);
  }
}

export class LinkDiscoveryProvider implements SearchProvider {
  id = "page-links";
  coverage = "Links found on pages that were already crawled and approved.";
  constructor(private links: { link: PageLink; fromUrl: string }[]) {}
  async search(input: SearchInput): Promise<SearchResult[]> {
    const results: SearchResult[] = this.links
      .filter(({ link }) => !hasForbiddenExtension(link.url))
      .map(({ link }) => ({
        url: link.url,
        title: link.text || link.url,
        snippet: link.text,
        discoveredBy: "page-link" as const,
      }));
    return rankByQuery(results, input).slice(0, input.maxResults ?? 50);
  }
}

/** Deterministic mock provider for tests and the first-run demo. */
export class MockSearchProvider implements SearchProvider {
  id = "mock";
  coverage = "A fixed, local fixture result list (mock provider — no real web search).";
  constructor(private fixtures: SearchResult[]) {}
  async search(input: SearchInput): Promise<SearchResult[]> {
    return rankByQuery(this.fixtures, input).slice(0, input.maxResults ?? 20);
  }
}

/** Simple keyword-overlap ranking of discovered candidates. */
export function rankByQuery(results: SearchResult[], input: SearchInput): SearchResult[] {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const scored = results.map((result) => {
    const haystack = `${result.title} ${result.snippet ?? ""} ${result.url}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (haystack.includes(term)) score++;
    if (result.publishedAt) score += 0.25;
    return { result, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.result);
}

/**
 * Score a candidate BEFORE crawling it, so crawl budget goes to the strongest
 * candidates. Deduplicates by normalized URL and balances domains.
 */
export function scoreCandidates(
  candidates: SearchResult[],
  options: { query: string; maxCandidates: number; maxPerDomain: number }
): SearchResult[] {
  const seen = new Set<string>();
  const domainCounts = new Map<string, number>();
  const ranked = rankByQuery(candidates, { query: options.query });
  const out: SearchResult[] = [];
  for (const candidate of ranked) {
    if (out.length >= options.maxCandidates) break;
    const normalized = normalizeUrl(candidate.url);
    if (!normalized || seen.has(normalized)) continue;
    const domain = domainOf(normalized);
    const count = domainCounts.get(domain) ?? 0;
    if (count >= options.maxPerDomain) continue;
    seen.add(normalized);
    domainCounts.set(domain, count + 1);
    out.push({ ...candidate, url: normalized });
  }
  return out;
}
