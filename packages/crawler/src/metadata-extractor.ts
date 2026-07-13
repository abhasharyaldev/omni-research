import type { CheerioAPI } from "cheerio";
import { parseMetaDate } from "@omni/shared";
import type { ExtractedMetadata } from "./crawler-types.js";

function firstMeta($: CheerioAPI, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const el = $(selector).first();
    if (el.length) {
      const content = el.attr("content") ?? el.attr("datetime") ?? el.text();
      const trimmed = content?.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function fromJsonLd($: CheerioAPI): Partial<ExtractedMetadata> {
  const out: Partial<ExtractedMetadata> = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 200_000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const nodes: any[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as any)["@graph"])
        ? (parsed as any)["@graph"]
        : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] ?? "");
      if (!/Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|WebPage/i.test(type)) continue;
      out.title ??= typeof node.headline === "string" ? node.headline : undefined;
      out.publishedAt ??= parseMetaDate(node.datePublished);
      out.modifiedAt ??= parseMetaDate(node.dateModified);
      const author = node.author;
      if (!out.author && author) {
        if (typeof author === "string") out.author = author;
        else if (Array.isArray(author)) {
          out.author = author
            .map((a: any) => (typeof a === "string" ? a : a?.name))
            .filter(Boolean)
            .join(", ");
        } else if (typeof author === "object" && author.name) out.author = String(author.name);
      }
      const publisher = node.publisher;
      if (!out.publisher && publisher && typeof publisher === "object" && publisher.name) {
        out.publisher = String(publisher.name);
      }
    }
  });
  return out;
}

export function extractMetadata($: CheerioAPI, pageUrl: string): ExtractedMetadata {
  const jsonLd = fromJsonLd($);

  const title =
    jsonLd.title ??
    firstMeta($, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ??
    $("title").first().text().trim() ??
    undefined;

  const author =
    jsonLd.author ??
    firstMeta($, [
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="parsely-author"]',
      '[rel="author"]',
      ".byline a",
      ".author-name",
    ]);

  const siteName = firstMeta($, ['meta[property="og:site_name"]', 'meta[name="application-name"]']);
  const publisher = jsonLd.publisher ?? siteName;

  const publishedAt =
    jsonLd.publishedAt ??
    parseMetaDate(
      firstMeta($, [
        'meta[property="article:published_time"]',
        'meta[name="date"]',
        'meta[name="dc.date"]',
        'meta[name="dcterms.date"]',
        'meta[name="parsely-pub-date"]',
        'meta[itemprop="datePublished"]',
        "time[datetime]",
        "time[pubdate]",
      ])
    );

  const modifiedAt =
    jsonLd.modifiedAt ??
    parseMetaDate(
      firstMeta($, ['meta[property="article:modified_time"]', 'meta[itemprop="dateModified"]'])
    );

  const description = firstMeta($, [
    'meta[name="description"]',
    'meta[property="og:description"]',
  ]);

  const language =
    $("html").attr("lang")?.trim() ||
    firstMeta($, ['meta[http-equiv="content-language"]']) ||
    undefined;

  let canonicalUrl: string | undefined;
  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  if (canonicalHref) {
    try {
      canonicalUrl = new URL(canonicalHref, pageUrl).toString();
    } catch {
      canonicalUrl = undefined;
    }
  }

  const section = firstMeta($, ['meta[property="article:section"]'])?.toLowerCase();
  const ogType = firstMeta($, ['meta[property="og:type"]'])?.toLowerCase();
  const isOpinionSection =
    section === "opinion" ||
    section === "editorial" ||
    /\/(opinion|editorial|op-ed|commentary)\//i.test(pageUrl) ||
    (ogType === "article" && /opinion/i.test(title ?? ""));

  return {
    title: title || undefined,
    author,
    publisher,
    description,
    language,
    publishedAt,
    modifiedAt,
    canonicalUrl,
    siteName,
    isOpinionSection,
  };
}
