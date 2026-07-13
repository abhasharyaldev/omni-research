import { describe, expect, it } from "vitest";
import {
  CRAWL_LIMIT_CEILINGS,
  clampCrawlLimits,
  newId,
  parseMetaDate,
  sha256Hex,
  textSimilarity,
} from "../src/index.js";

describe("clampCrawlLimits", () => {
  it("applies defaults when nothing is provided", () => {
    const limits = clampCrawlLimits(undefined);
    expect(limits.maxPagesPerRun).toBe(50);
    expect(limits.maxDepth).toBe(2);
  });

  it("never allows values above the hard ceilings (no unlimited crawling)", () => {
    const limits = clampCrawlLimits({
      maxPagesPerRun: 999_999,
      maxDepth: 99,
      maxConcurrency: 1000,
      maxResponseBytes: Number.MAX_SAFE_INTEGER,
      maxRunDurationMs: Number.MAX_SAFE_INTEGER,
    });
    expect(limits.maxPagesPerRun).toBe(CRAWL_LIMIT_CEILINGS.maxPagesPerRun);
    expect(limits.maxDepth).toBe(CRAWL_LIMIT_CEILINGS.maxDepth);
    expect(limits.maxConcurrency).toBe(CRAWL_LIMIT_CEILINGS.maxConcurrency);
    expect(limits.maxResponseBytes).toBe(CRAWL_LIMIT_CEILINGS.maxResponseBytes);
  });

  it("lets advanced users lower limits", () => {
    const limits = clampCrawlLimits({ maxPagesPerRun: 3, maxDepth: 0 });
    expect(limits.maxPagesPerRun).toBe(3);
    expect(limits.maxDepth).toBe(0);
  });
});

describe("utils", () => {
  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId("x")));
    expect(ids.size).toBe(200);
  });

  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("measures text similarity", () => {
    const a = "spaced repetition improves long term retention in students";
    expect(textSimilarity(a, a)).toBe(1);
    expect(textSimilarity(a, "the weather is nice in the mountains today folks")).toBe(0);
  });

  it("parses metadata dates without guessing ambiguous formats", () => {
    expect(parseMetaDate("2026-03-04T10:00:00Z")?.toISOString()).toBe("2026-03-04T10:00:00.000Z");
    expect(parseMetaDate("March 4, 2026")).toBeInstanceOf(Date);
    expect(parseMetaDate("05/01/2026")).toBeUndefined(); // ambiguous DD/MM vs MM/DD
    expect(parseMetaDate("")).toBeUndefined();
    expect(parseMetaDate("not a date")).toBeUndefined();
  });
});
