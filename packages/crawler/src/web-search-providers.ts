import { sleep } from "@omni/shared";
import type { SearchInput, SearchProvider, SearchResult } from "./crawler-types.js";
import { normalizeUrl } from "./url-normalizer.js";

/**
 * Optional keyed web-search providers. These are strictly OPTIONAL: the core
 * keyless discovery (user URLs, RSS, sitemaps, page links) always works
 * without them. Keys are read from server-side environment variables only —
 * they are never sent to the frontend, logged, or stored in the database.
 *
 * Every result URL still goes through the full crawl-safety pipeline
 * (SSRF validation, robots.txt, limits) before anything is fetched.
 */

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;

type FetchJsonOptions = { headers?: Record<string, string> };

class ProviderRateLimiter {
  private nextAllowedAt = 0;
  constructor(private minIntervalMs: number) {}
  async acquire(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowedAt) await sleep(this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;
  }
}

async function fetchJsonWithRetry(url: string, options: FetchJsonOptions): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: options.headers, signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`search provider returned ${response.status}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`search provider returned ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err as Error;
      if ((err as Error).name === "AbortError") lastError = new Error("search request timed out");
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("search request failed");
}

function toResults(raw: { url?: string; title?: string; snippet?: string; publishedAt?: string }[], providerId: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const item of raw) {
    if (!item.url) continue;
    const normalized = normalizeUrl(item.url);
    if (!normalized) continue;
    const publishedAt = item.publishedAt ? new Date(item.publishedAt) : undefined;
    out.push({
      url: normalized,
      title: (item.title ?? normalized).slice(0, 300),
      snippet: item.snippet?.slice(0, 500),
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined,
      discoveredBy: "search-provider",
      providerId,
    });
  }
  return out;
}

/** Brave Search API (https://api.search.brave.com). Free tier available. */
export class BraveSearchProvider implements SearchProvider {
  id = "brave";
  coverage = "Brave Search web index (keyed API; results are candidates only and still pass all crawl-safety checks).";
  private limiter = new ProviderRateLimiter(1100); // free tier: ~1 req/s

  constructor(private apiKey: string) {}

  async search(input: SearchInput): Promise<SearchResult[]> {
    await this.limiter.acquire();
    const params = new URLSearchParams({
      q: input.query.slice(0, 400),
      count: String(Math.min(input.maxResults ?? 10, 20)),
    });
    const data = await fetchJsonWithRetry(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { "X-Subscription-Token": this.apiKey, Accept: "application/json" },
    });
    const results = Array.isArray(data?.web?.results) ? data.web.results : [];
    return toResults(
      results.map((r: any) => ({
        url: r.url,
        title: r.title,
        snippet: r.description,
        publishedAt: r.page_age,
      })),
      this.id
    );
  }
}

/** Google Programmable Search (Custom Search JSON API). */
export class GoogleCseProvider implements SearchProvider {
  id = "google-cse";
  coverage = "Google Programmable Search over your configured search engine (keyed API; candidates only).";
  private limiter = new ProviderRateLimiter(1000);

  constructor(
    private apiKey: string,
    private engineId: string
  ) {}

  async search(input: SearchInput): Promise<SearchResult[]> {
    await this.limiter.acquire();
    const params = new URLSearchParams({
      key: this.apiKey,
      cx: this.engineId,
      q: input.query.slice(0, 400),
      num: String(Math.min(input.maxResults ?? 10, 10)),
    });
    const data = await fetchJsonWithRetry(`https://www.googleapis.com/customsearch/v1?${params}`, {});
    const items = Array.isArray(data?.items) ? data.items : [];
    return toResults(
      items.map((r: any) => ({
        url: r.link,
        title: r.title,
        snippet: r.snippet,
        publishedAt: r.pagemap?.metatags?.[0]?.["article:published_time"],
      })),
      this.id
    );
  }
}

export type WebSearchConfig = {
  braveApiKey?: string;
  googleCseApiKey?: string;
  googleCseId?: string;
  /** Preferred provider id when several are configured. */
  preferred?: string;
};

export function webSearchConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebSearchConfig {
  return {
    braveApiKey: env.BRAVE_SEARCH_API_KEY || undefined,
    googleCseApiKey: env.GOOGLE_CSE_API_KEY || undefined,
    googleCseId: env.GOOGLE_CSE_ID || undefined,
    preferred: env.SEARCH_PROVIDER || undefined,
  };
}

/**
 * Returns the configured keyed web-search providers, preferred first.
 * Empty array when no keys are configured — callers must treat web search
 * as an optional enhancement, never a requirement.
 */
export function getWebSearchProviders(config: WebSearchConfig = webSearchConfigFromEnv()): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (config.braveApiKey) providers.push(new BraveSearchProvider(config.braveApiKey));
  if (config.googleCseApiKey && config.googleCseId) {
    providers.push(new GoogleCseProvider(config.googleCseApiKey, config.googleCseId));
  }
  if (config.preferred) {
    providers.sort((a, b) => (a.id === config.preferred ? -1 : b.id === config.preferred ? 1 : 0));
  }
  return providers;
}
