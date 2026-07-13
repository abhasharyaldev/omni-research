import { describe, expect, it } from "vitest";
import {
  buildMatcher,
  countMatches,
  segmentsFromServerSnippet,
  splitForHighlight,
} from "./search-highlight";

describe("in-report search highlighting", () => {
  it("splits text into match segments case-insensitively", () => {
    const segments = splitForHighlight("Spaced repetition beats cramming. spaced practice wins.", "spaced");
    expect(segments.filter((s) => s.match)).toHaveLength(2);
    expect(segments.map((s) => s.text).join("")).toBe("Spaced repetition beats cramming. spaced practice wins.");
  });

  it("escapes regex special characters in queries", () => {
    const segments = splitForHighlight("cost is $5 (approx.)", "$5 (approx.)");
    expect(segments.some((s) => s.match && s.text === "$5 (approx.)")).toBe(true);
  });

  it("requires at least two characters", () => {
    expect(buildMatcher("a")).toBeNull();
    expect(splitForHighlight("aaa", "a")).toEqual([{ text: "aaa", match: false }]);
  });

  it("counts matches", () => {
    expect(countMatches("one two one two one", "one")).toBe(3);
    expect(countMatches("", "one")).toBe(0);
  });

  it("keeps citation markers intact by leaving non-matching text untouched", () => {
    const text = "Retention improves with spacing.[3]";
    const segments = splitForHighlight(text, "spacing");
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });
});

describe("server snippet rendering", () => {
  it("converts [[ ]] delimiters from ts_headline into match segments", () => {
    const segments = segmentsFromServerSnippet("Spaced [[repetition]] improves [[retention]] over time");
    const matches = segments.filter((s) => s.match).map((s) => s.text);
    expect(matches).toEqual(["repetition", "retention"]);
  });

  it("treats delimiter-free text as plain", () => {
    expect(segmentsFromServerSnippet("plain text")).toEqual([{ text: "plain text", match: false }]);
  });
});
