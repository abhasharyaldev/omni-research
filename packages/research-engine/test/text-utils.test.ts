import { describe, expect, it } from "vitest";
import { containsVerbatim, locateExcerpt, splitSentences } from "../src/text-utils.js";

describe("sentence splitting", () => {
  it("splits prose into citation-grade sentences", () => {
    const text =
      "Spaced repetition improves retention. It was documented by Ebbinghaus in 1885! Does it work for math? Yes — studies say so across many trials and conditions.\nShort.\nA heading line without punctuation that is long enough to keep here";
    const sentences = splitSentences(text);
    expect(sentences).toContain("Spaced repetition improves retention.");
    expect(sentences).toContain("It was documented by Ebbinghaus in 1885!");
    expect(sentences).not.toContain("Short."); // below length threshold
  });

  it("caps sentence count and length", () => {
    const text = Array.from({ length: 200 }, (_, i) => `This is a reasonably long sentence number ${i} for testing purposes.`).join(" ");
    expect(splitSentences(text, { maxSentences: 10 })).toHaveLength(10);
  });
});

describe("verbatim containment (citation verification core)", () => {
  const source = "The spacing effect was first documented by  Hermann Ebbinghaus in 1885,\nwho measured “forgetting curves”.";

  it("tolerates whitespace and quote-style differences", () => {
    expect(containsVerbatim(source, "documented by Hermann Ebbinghaus in 1885")).toBe(true);
    expect(containsVerbatim(source, 'measured "forgetting curves"')).toBe(true);
  });

  it("rejects fabricated excerpts", () => {
    expect(containsVerbatim(source, "documented by Hermann Ebbinghaus in 1990")).toBe(false);
    expect(containsVerbatim(source, "")).toBe(false);
  });
});

describe("locateExcerpt", () => {
  it("returns a paragraph locator", () => {
    const source = "First paragraph here.\nSecond paragraph mentions the key fact.\nThird.";
    expect(locateExcerpt(source, "key fact")).toBe("paragraph 2");
    expect(locateExcerpt(source, "missing")).toBeUndefined();
  });
});
