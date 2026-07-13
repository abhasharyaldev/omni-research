import { describe, expect, it } from "vitest";
import { detectConflicts, findEvidenceGaps, type ConflictInput } from "../src/reconcile.js";

const row = (overrides: Partial<ConflictInput>): ConflictInput => ({
  id: Math.random().toString(36).slice(2),
  sourceId: "s1",
  claim: "",
  evidenceText: "",
  sourceTitle: "Source",
  ...overrides,
});

describe("disagreement detection", () => {
  it("detects negation mismatches between different sources on the same topic", () => {
    const conflicts = detectConflicts([
      row({
        sourceId: "a",
        claim: "Spaced repetition improves long-term retention in students",
        evidenceText: "Spaced repetition improves long-term retention in students.",
      }),
      row({
        sourceId: "b",
        claim: "Spaced repetition does not improve long-term retention in students",
        evidenceText: "Our study found spaced repetition does not improve long-term retention in students.",
      }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.signal).toBe("negation-mismatch");
  });

  it("detects antonym-pair conflicts (increase vs decrease)", () => {
    const conflicts = detectConflicts([
      row({ sourceId: "a", claim: "Solar capacity increased in Europe this year", evidenceText: "Capacity increased." }),
      row({ sourceId: "b", claim: "Solar capacity decreased in Europe this year", evidenceText: "Capacity decreased." }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.signal).toBe("antonym-pair");
  });

  it("ignores same-source pairs and unrelated topics", () => {
    expect(
      detectConflicts([
        row({ sourceId: "a", claim: "Coffee raises alertness" }),
        row({ sourceId: "a", claim: "Coffee does not raise alertness" }),
      ])
    ).toHaveLength(0);
    expect(
      detectConflicts([
        row({ sourceId: "a", claim: "Coffee raises alertness in adults" }),
        row({ sourceId: "b", claim: "Medieval trade routes did not cross the Alps" }),
      ])
    ).toHaveLength(0);
  });
});

describe("evidence gap detection", () => {
  it("finds subquestions below the evidence floor", () => {
    const gaps = findEvidenceGaps(
      [
        { id: "sq1", text: "What is X?" },
        { id: "sq2", text: "Does X work?" },
      ],
      [{ subquestionId: "sq1" }, { subquestionId: "sq1" }, { subquestionId: "sq2" }]
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.subquestionId).toBe("sq2");
    expect(gaps[0]!.evidenceCount).toBe(1);
  });

  it("returns empty when coverage is sufficient", () => {
    const gaps = findEvidenceGaps(
      [{ id: "sq1", text: "Q" }],
      [{ subquestionId: "sq1" }, { subquestionId: "sq1" }]
    );
    expect(gaps).toHaveLength(0);
  });
});
