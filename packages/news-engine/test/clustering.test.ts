import { describe, expect, it } from "vitest";
import { clusterArticles, extractEventDate } from "../src/clustering.js";

describe("news clustering", () => {
  it("clusters same-event coverage and separates unrelated stories", () => {
    const clusters = clusterArticles([
      {
        sourceId: "a",
        title: "OpenAI releases new reasoning model for developers",
        snippet: "The company announced a new reasoning model available to developers today.",
        publishedAt: new Date("2026-07-01"),
        url: "https://one.example/a",
      },
      {
        sourceId: "b",
        title: "New OpenAI reasoning model released to developers",
        snippet: "Developers can now access the new reasoning model announced by OpenAI.",
        publishedAt: new Date("2026-07-02"),
        url: "https://two.example/b",
      },
      {
        sourceId: "c",
        title: "Solar power installations hit record high in Europe",
        snippet: "European solar capacity grew at a record pace this quarter.",
        publishedAt: new Date("2026-07-02"),
        url: "https://three.example/c",
      },
    ]);
    expect(clusters).toHaveLength(2);
    const aiCluster = clusters.find((c) => c.articles.some((a) => a.sourceId === "a"))!;
    expect(aiCluster.articles.map((a) => a.sourceId).sort()).toEqual(["a", "b"]);
    expect(aiCluster.earliestPublishedAt?.toISOString().slice(0, 10)).toBe("2026-07-01");
  });

  it("marks identical content hashes as syndicated copies, not separate developments", () => {
    const clusters = clusterArticles([
      { sourceId: "x", title: "Wire story", contentHash: "same", publishedAt: new Date("2026-07-01"), url: "u1" },
      { sourceId: "y", title: "Wire story", contentHash: "same", publishedAt: new Date("2026-07-01"), url: "u2" },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.syndicatedSourceIds).toContain("y");
  });
});

describe("event date extraction (distinct from publication date)", () => {
  it("finds ISO and long-form dates", () => {
    expect(extractEventDate("The launch happened on 2026-07-08 at the site.")?.toISOString().slice(0, 10)).toBe("2026-07-08");
    expect(extractEventDate("The vote took place on July 8, 2026 in parliament.")?.toISOString().slice(0, 10)).toBe("2026-07-08");
    expect(extractEventDate("The vote took place on July 8 in parliament.", 2026)?.toISOString().slice(0, 10)).toBe("2026-07-08");
  });

  it("returns undefined instead of guessing", () => {
    expect(extractEventDate("No date mentioned here at all.")).toBeUndefined();
  });
});
