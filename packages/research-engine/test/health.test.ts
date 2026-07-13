import { describe, expect, it } from "vitest";
import { scoreHealth, type HealthInputs } from "../src/health.js";

const base = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  sources: [
    { domain: "a.gov", classification: "government", qualityScore: 80, duplicateOfId: null },
    { domain: "b.edu", classification: "academic", qualityScore: 70, duplicateOfId: null },
    { domain: "c.org", classification: "journalism", qualityScore: 60, duplicateOfId: null },
    { domain: "a.gov", classification: "government", qualityScore: 80, duplicateOfId: "dup" },
  ],
  evidence: [
    { subquestionId: "sq1", evidenceStrength: "strong" },
    { subquestionId: "sq1", evidenceStrength: "moderate" },
    { subquestionId: "sq1", evidenceStrength: "moderate" },
    { subquestionId: "sq2", evidenceStrength: "moderate" },
    { subquestionId: "sq2", evidenceStrength: "weak" },
  ],
  subquestions: [
    { id: "sq1", text: "Q1" },
    { id: "sq2", text: "Q2" },
  ],
  claims: [],
  claimStancesBySubquestion: new Map(),
  strongestBySubquestion: new Map([["sq1", { title: "Gov report", qualityScore: 80, classification: "government", sourceId: "s1" }]]),
  citationCount: 6,
  citationsVerified: true,
  runId: "run1",
  ...over,
});

describe("deterministic research health", () => {
  it("scores a well-covered, verified project as high confidence with reasons", () => {
    const health = scoreHealth(base());
    expect(health.overall).toBe("high");
    expect(health.sourceCount).toBe(3); // duplicates excluded
    expect(health.distinctDomains).toBe(3);
    expect(health.avgSourceQuality).toBe(70);
    expect(health.primaryOfficialCount).toBe(1); // government only (dup excluded, academic/journalism not primary)
    expect(health.coveredSubquestions).toBe(2);
    expect(health.reasons.length).toBeGreaterThanOrEqual(7);
    expect(health.coverage[0]!.confidence).toBe("high"); // 3 rows incl. strong
    expect(health.coverage[1]!.confidence).toBe("medium");
    expect(health.coverage[0]!.strongestSource?.title).toBe("Gov report");
  });

  it("drops to low when citations are unverified", () => {
    const health = scoreHealth(base({ citationsVerified: false }));
    expect(health.overall).toBe("low");
    expect(health.reasons.some((r) => r.includes("not verified"))).toBe(true);
  });

  it("penalizes unresolved disagreements and weak claims", () => {
    const health = scoreHealth(
      base({
        claims: [
          { verificationStatus: "disputed", statusExplanation: "conflict remains unresolved" },
          { verificationStatus: "unsupported", statusExplanation: null },
        ],
      })
    );
    expect(health.disagreementCount).toBe(1);
    expect(health.unresolvedDisagreementCount).toBe(1);
    expect(health.weakClaimCount).toBe(1);
    expect(health.overall).toBe("medium");
  });

  it("marks empty coverage honestly", () => {
    const health = scoreHealth(
      base({ evidence: [], subquestions: [{ id: "sq1", text: "Q1" }], strongestBySubquestion: new Map() })
    );
    expect(health.coverage[0]!.evidenceCount).toBe(0);
    expect(health.coverage[0]!.weakestGap).toBe("no evidence at all");
    expect(health.coverage[0]!.confidence).toBe("low");
    expect(health.overall).not.toBe("high");
  });

  it("counts opposing stances into the matrix", () => {
    const health = scoreHealth(
      base({ claimStancesBySubquestion: new Map([["sq1", { supports: 2, opposes: 1 }]]) })
    );
    expect(health.coverage[0]!.opposingCount).toBe(1);
    expect(health.coverage[0]!.weakestGap).toBe("opposing evidence exists");
  });
});
