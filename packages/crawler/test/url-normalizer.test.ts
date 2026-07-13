import { describe, expect, it } from "vitest";
import {
  domainOf,
  hasForbiddenExtension,
  looksLikeFeed,
  looksLikePdf,
  looksLikeSitemap,
  normalizeUrl,
} from "../src/url-normalizer.js";

describe("normalizeUrl", () => {
  it("strips fragments, tracking params, default ports, and www", () => {
    expect(normalizeUrl("https://www.Example.com:443/a/?utm_source=x&b=2&a=1#frag")).toBe(
      "https://example.com/a?a=1&b=2"
    );
  });

  it("normalizes trailing slashes and index files", () => {
    expect(normalizeUrl("https://example.com/dir/")).toBe("https://example.com/dir");
    expect(normalizeUrl("https://example.com/dir/index.html")).toBe("https://example.com/dir");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("resolves relative URLs against a base", () => {
    expect(normalizeUrl("../b.html", "https://example.com/a/x.html")).toBe("https://example.com/b.html");
  });

  it("rejects non-http protocols and garbage", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("mailto:x@y.com")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("keeps meaningful query params sorted", () => {
    expect(normalizeUrl("https://example.com/search?z=1&a=2&fbclid=abc")).toBe(
      "https://example.com/search?a=2&z=1"
    );
  });
});

describe("url type detection", () => {
  it("detects pdf, feed, and sitemap URLs", () => {
    expect(looksLikePdf("https://example.com/paper.PDF")).toBe(true);
    expect(looksLikeFeed("https://example.com/feed.xml")).toBe(true);
    expect(looksLikeFeed("https://example.com/blog/rss")).toBe(true);
    expect(looksLikeSitemap("https://example.com/sitemap.xml")).toBe(true);
    expect(looksLikeSitemap("https://example.com/sitemap-news.xml")).toBe(true);
    expect(looksLikePdf("https://example.com/page.html")).toBe(false);
  });

  it("refuses executable/archive extensions", () => {
    for (const bad of ["setup.exe", "x.msi", "a.zip", "b.tar.gz", "run.sh", "app.dmg", "lib.dll"]) {
      expect(hasForbiddenExtension(`https://example.com/${bad}`), bad).toBe(true);
    }
    expect(hasForbiddenExtension("https://example.com/report.pdf")).toBe(false);
  });

  it("extracts domains", () => {
    expect(domainOf("https://www.sub.example.co.uk/x")).toBe("sub.example.co.uk");
  });
});
