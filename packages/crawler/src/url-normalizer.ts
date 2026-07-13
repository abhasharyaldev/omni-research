/**
 * URL normalization for deduplication. Two URLs that normalize identically are
 * treated as the same page.
 */

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "cmpid",
  "s_kwcid",
  "spm",
  "_hsenc",
  "_hsmi",
  "vero_id",
  "yclid",
]);

export function normalizeUrl(rawUrl: string, baseUrl?: string): string | null {
  let url: URL;
  try {
    url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.hostname.startsWith("www.") && url.hostname.split(".").length > 2) {
    url.hostname = url.hostname.slice(4);
  }
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);

  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  // Normalize common index documents
  pathname = pathname.replace(/\/index\.(html?|php|asp)$/i, "");
  if (pathname === "") pathname = "/";
  url.pathname = pathname;

  return url.toString();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function looksLikePdf(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export function looksLikeFeed(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      path.endsWith(".rss") ||
      path.endsWith(".atom") ||
      path.endsWith("/feed") ||
      path.endsWith("/rss") ||
      path.endsWith("feed.xml") ||
      path.endsWith("rss.xml") ||
      path.endsWith("atom.xml")
    );
  } catch {
    return false;
  }
}

export function looksLikeSitemap(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.includes("sitemap") && path.endsWith(".xml");
  } catch {
    return false;
  }
}

/** File extensions we refuse to download at all. */
const FORBIDDEN_EXTENSIONS =
  /\.(exe|msi|dmg|pkg|apk|deb|rpm|bat|cmd|ps1|sh|jar|iso|img|zip|rar|7z|tar|gz|bz2|xz|dll|bin|scr|com)$/i;

export function hasForbiddenExtension(url: string): boolean {
  try {
    return FORBIDDEN_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return true;
  }
}
