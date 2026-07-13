import type { UrlPolicy } from "@omni/security";
import {
  fetchFeed,
  fetchSitemap,
  getWebSearchProviders,
  looksLikeFeed,
  looksLikeSitemap,
  normalizeUrl,
  MockSearchProvider,
  type SearchProvider,
  type SearchResult,
} from "@omni/crawler";
import type { PlanOutput } from "./schemas.js";

export type DiscoveryQueryRecord = { query: string; providerId: string; results: number };

export type DiscoveryOutcome = {
  candidates: SearchResult[];
  queries: DiscoveryQueryRecord[];
  notes: string[];
};

export type DiscoveryArgs = {
  startingUrls: string[];
  plan: PlanOutput;
  policy: UrlPolicy;
  userAgent: string;
  dateRangeStart?: Date | null;
  dateRangeEnd?: Date | null;
  /** Fixture results for tests/demos (MockSearchProvider). */
  mockSearchResults?: SearchResult[];
  /** Extra follow-up queries (multi-turn reasoning) — replaces plan queries when set. */
  queriesOverride?: string[];
  /** Keyed web-search providers; defaults to whatever the environment configures. */
  webSearchProviders?: SearchProvider[];
  maxQueriesPerProvider?: number;
};

/**
 * Source discovery shared by the run preview and the live pipeline: user URLs,
 * RSS feeds, sitemaps, optional keyed web search, and mock fixtures. Every
 * discovered URL is labeled with the provider that produced it, and every
 * query is recorded so reports can state exactly what was searched.
 */
export async function discoverCandidates(args: DiscoveryArgs): Promise<DiscoveryOutcome> {
  const candidates: SearchResult[] = [];
  const queries: DiscoveryQueryRecord[] = [];
  const notes: string[] = [];
  const { policy, userAgent } = args;

  const startingUrls = args.startingUrls.filter(Boolean);
  const feedUrls = startingUrls.filter(looksLikeFeed);
  const sitemapUrls = startingUrls.filter(looksLikeSitemap);
  const directUrls = startingUrls.filter((u) => !looksLikeFeed(u) && !looksLikeSitemap(u));

  for (const url of directUrls) {
    const normalized = normalizeUrl(url);
    if (normalized) {
      candidates.push({ url: normalized, title: normalized, discoveredBy: "user", providerId: "manual-urls" });
    }
  }
  if (directUrls.length > 0) notes.push(`${directUrls.length} user-provided URL(s)`);

  for (const feedUrl of feedUrls) {
    try {
      const feed = await fetchFeed(feedUrl, { policy, userAgent });
      let added = 0;
      for (const item of feed.items) {
        if (args.dateRangeStart && item.publishedAt && item.publishedAt < args.dateRangeStart) continue;
        if (args.dateRangeEnd && item.publishedAt && item.publishedAt > args.dateRangeEnd) continue;
        candidates.push({
          url: item.url,
          title: item.title,
          snippet: item.snippet,
          publishedAt: item.publishedAt,
          discoveredBy: "rss",
          providerId: "rss",
        });
        added++;
      }
      notes.push(`feed ${feedUrl}: ${added} item(s)`);
      queries.push({ query: feedUrl, providerId: "rss", results: added });
    } catch (err) {
      notes.push(`feed ${feedUrl} failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  for (const sitemapUrl of sitemapUrls) {
    try {
      const sitemap = await fetchSitemap(sitemapUrl, { policy, userAgent, maxEntries: 300 });
      candidates.push(
        ...sitemap.entries.map((entry) => ({
          url: entry.url,
          title: entry.url,
          publishedAt: entry.lastModified,
          discoveredBy: "sitemap" as const,
          providerId: "sitemap",
        }))
      );
      notes.push(`sitemap ${sitemapUrl}: ${sitemap.entries.length} URL(s)`);
      queries.push({ query: sitemapUrl, providerId: "sitemap", results: sitemap.entries.length });
    } catch (err) {
      notes.push(`sitemap ${sitemapUrl} failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }

  const searchQueries = (args.queriesOverride ?? args.plan.discoveryQueries).slice(
    0,
    args.maxQueriesPerProvider ?? 5
  );

  // Mock fixtures (tests/demos).
  if (args.mockSearchResults?.length) {
    const mock = new MockSearchProvider(args.mockSearchResults);
    for (const query of searchQueries) {
      const results = await mock.search({ query });
      candidates.push(...results.map((r) => ({ ...r, providerId: "mock" })));
      queries.push({ query, providerId: "mock", results: results.length });
    }
  }

  // Optional keyed web search: the FIRST configured provider handles the
  // queries; failures degrade gracefully to keyless discovery.
  const webProviders = args.webSearchProviders ?? getWebSearchProviders();
  const webProvider = webProviders[0];
  if (webProvider && searchQueries.length > 0) {
    for (const query of searchQueries) {
      try {
        const results = await webProvider.search({
          query,
          maxResults: 10,
          dateRangeStart: args.dateRangeStart ?? undefined,
          dateRangeEnd: args.dateRangeEnd ?? undefined,
        });
        candidates.push(...results);
        queries.push({ query, providerId: webProvider.id, results: results.length });
      } catch (err) {
        notes.push(`web search (${webProvider.id}) "${query.slice(0, 60)}" failed: ${(err as Error).message.slice(0, 100)}`);
        queries.push({ query, providerId: webProvider.id, results: 0 });
      }
    }
    notes.push(`web search via ${webProvider.id}: ${searchQueries.length} quer(ies)`);
  } else if (searchQueries.length > 0 && !args.mockSearchResults?.length) {
    notes.push("no web-search provider configured — discovery covers configured URLs/feeds/sitemaps and page links only");
  }

  return { candidates, queries, notes };
}
