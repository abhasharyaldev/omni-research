import Parser from "rss-parser";
import { parseMetaDate } from "@omni/shared";
import { safeFetch, type UrlPolicy } from "@omni/security";
import { normalizeUrl } from "./url-normalizer.js";

export type FeedItem = {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: Date;
  author?: string;
};

export type FeedResult = {
  feedUrl: string;
  feedTitle?: string;
  items: FeedItem[];
};

/** Fetch and parse an RSS/Atom feed through the SSRF-safe fetcher. */
export async function fetchFeed(
  feedUrl: string,
  options: { policy?: UrlPolicy; userAgent?: string; timeoutMs?: number; maxItems?: number } = {}
): Promise<FeedResult> {
  const response = await safeFetch(feedUrl, {
    policy: options.policy,
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: 5_000_000,
    allowedContentTypes: [
      "application/rss+xml",
      "application/atom+xml",
      "application/xml",
      "text/xml",
      "application/rdf+xml",
      "text/html", // some servers mislabel feeds; the parser will reject non-feeds
      "text/plain",
    ],
  });
  if (response.status >= 400) {
    throw new Error(`Feed ${feedUrl} returned HTTP ${response.status}`);
  }
  const parser = new Parser({ timeout: options.timeoutMs ?? 20_000 });
  const feed = await parser.parseString(response.body.toString("utf8"));

  const items: FeedItem[] = [];
  for (const item of feed.items ?? []) {
    if (items.length >= (options.maxItems ?? 100)) break;
    const link = item.link ? normalizeUrl(item.link, feedUrl) : null;
    if (!link) continue;
    items.push({
      url: link,
      title: (item.title ?? "Untitled").trim().slice(0, 300),
      snippet: (item.contentSnippet ?? item.summary ?? "").trim().slice(0, 500) || undefined,
      publishedAt: parseMetaDate(item.isoDate ?? item.pubDate),
      author: (item.creator ?? (item as any).author ?? undefined)?.toString().slice(0, 200),
    });
  }
  return { feedUrl: response.finalUrl, feedTitle: feed.title?.trim(), items };
}
