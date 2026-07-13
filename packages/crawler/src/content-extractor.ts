import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { load, type CheerioAPI } from "cheerio";
import type { PageLink } from "./crawler-types.js";
import { normalizeUrl } from "./url-normalizer.js";

export type ExtractedContent = {
  mainText: string;
  headings: string[];
  wordCount: number;
  outboundLinks: PageLink[];
  usedReadability: boolean;
  paywallSuspected: boolean;
  loginSuspected: boolean;
  looksJsRendered: boolean;
};

const BOILERPLATE_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "script",
  "style",
  "noscript",
  "iframe",
  "form",
  "svg",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  ".nav",
  ".navbar",
  ".menu",
  ".sidebar",
  ".advertisement",
  ".ad",
  ".ads",
  ".cookie-banner",
  ".cookie-notice",
  ".newsletter-signup",
  ".social-share",
  ".comments",
  "#comments",
];

const PAYWALL_HINTS =
  /(subscribe to (read|continue)|subscription required|to continue reading|remaining free articles|this article is for subscribers|already a subscriber)/i;
const LOGIN_HINTS =
  /(please (log|sign) in to (view|continue|read)|login required|sign in to your account to)/i;

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractContent(html: string, pageUrl: string): ExtractedContent {
  const $ = load(html);

  // Outbound links from the ORIGINAL document (before boilerplate removal we
  // still want article links, so collect from main content area if present).
  const outboundLinks = extractLinks($, pageUrl);
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length <= 300 && headings.length < 60) headings.push(text);
  });

  // Try Readability first for article-style extraction.
  let mainText = "";
  let usedReadability = false;
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as any, { charThreshold: 250 });
    const article = reader.parse();
    if (article?.textContent && article.textContent.trim().length >= 250) {
      mainText = collapseWhitespace(article.textContent);
      usedReadability = true;
    }
  } catch {
    usedReadability = false;
  }

  // Fallback: cheerio with boilerplate stripped.
  if (!mainText) {
    const $clean = load(html);
    for (const selector of BOILERPLATE_SELECTORS) $clean(selector).remove();
    const container = $clean("main, article, #content, .content, body").first();
    mainText = collapseWhitespace(container.text());
  }

  const wordCount = mainText ? mainText.split(/\s+/).filter(Boolean).length : 0;
  const bodyTextLength = collapseWhitespace($("body").text()).length;
  const scriptCount = $("script").length;
  const looksJsRendered =
    wordCount < 40 &&
    (scriptCount >= 3 ||
      $("[data-reactroot], #__next, #root, #app, [ng-app], [data-v-app]").length > 0);

  const probe = `${mainText.slice(0, 4000)}\n${$("body").text().slice(0, 4000)}`;
  return {
    mainText,
    headings,
    wordCount,
    outboundLinks,
    usedReadability,
    paywallSuspected: PAYWALL_HINTS.test(probe) && wordCount < 400,
    loginSuspected: LOGIN_HINTS.test(probe) && bodyTextLength < 3000,
    looksJsRendered,
  };
}

export function extractLinks($: CheerioAPI, pageUrl: string): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  $("a[href]").each((_, el) => {
    if (links.length >= 300) return false;
    const href = $(el).attr("href");
    if (!href) return;
    const rel = $(el).attr("rel");
    if (rel && /nofollow/i.test(rel)) return; // respect publisher intent
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    links.push({
      url: normalized,
      text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 200),
      rel: rel ?? undefined,
    });
  });
  return links;
}
