import { load } from "cheerio";
import { parseMetaDate } from "@omni/shared";
import { safeFetch, type UrlPolicy } from "@omni/security";
import { normalizeUrl } from "./url-normalizer.js";

export type SitemapEntry = {
  url: string;
  lastModified?: Date;
};

export type SitemapResult = {
  sitemapUrl: string;
  entries: SitemapEntry[];
  childSitemaps: string[];
};

/**
 * Fetch and parse an XML sitemap (urlset or sitemapindex) through the
 * SSRF-safe fetcher. Nested sitemap indexes are returned as childSitemaps —
 * the caller decides whether to descend (bounded).
 */
export async function fetchSitemap(
  sitemapUrl: string,
  options: { policy?: UrlPolicy; userAgent?: string; timeoutMs?: number; maxEntries?: number } = {}
): Promise<SitemapResult> {
  const response = await safeFetch(sitemapUrl, {
    policy: options.policy,
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: 10_000_000,
    allowedContentTypes: ["application/xml", "text/xml", "text/plain", "application/x-gzip"],
  });
  if (response.status >= 400) {
    throw new Error(`Sitemap ${sitemapUrl} returned HTTP ${response.status}`);
  }

  const $ = load(response.body.toString("utf8"), { xmlMode: true });
  const maxEntries = options.maxEntries ?? 500;
  const entries: SitemapEntry[] = [];
  const childSitemaps: string[] = [];

  $("sitemapindex > sitemap > loc").each((_, el) => {
    if (childSitemaps.length >= 50) return false;
    const loc = $(el).text().trim();
    const normalized = loc ? normalizeUrl(loc, sitemapUrl) : null;
    if (normalized) childSitemaps.push(normalized);
  });

  $("urlset > url").each((_, el) => {
    if (entries.length >= maxEntries) return false;
    const loc = $(el).find("loc").first().text().trim();
    if (!loc) return;
    const normalized = normalizeUrl(loc, sitemapUrl);
    if (!normalized) return;
    const lastmod = $(el).find("lastmod").first().text().trim();
    entries.push({ url: normalized, lastModified: parseMetaDate(lastmod) });
  });

  return { sitemapUrl: response.finalUrl, entries, childSitemaps };
}
