import { describe, expect, it } from "vitest";
import { nextReview, qualityFromScore, updateMastery } from "../src/spaced-review.js";
import { gradeAnswer } from "../src/quiz-grader.js";

describe("spaced review (SM-2 style)", () => {
  it("grows intervals on success and resets on failure", () => {
    const state = { intervalDays: 1, ease: 2.5 };
    const first = nextReview(state, 5);
    expect(first.intervalDays).toBe(3);
    const second = nextReview(first, 4);
    expect(second.intervalDays).toBeGreaterThan(3);
    const failed = nextReview(second, 1);
    expect(failed.intervalDays).toBe(1);
    expect(failed.ease).toBeLessThan(second.ease);
  });

  it("clamps ease and interval", () => {
    let state = { intervalDays: 100, ease: 1.3 };
    for (let i = 0; i < 10; i++) state = nextReview(state, 0);
    expect(state.ease).toBeGreaterThanOrEqual(1.3);
    state = { intervalDays: 119, ease: 3.0 };
    expect(nextReview(state, 5).intervalDays).toBeLessThanOrEqual(120);
  });

  it("maps quiz scores to quality", () => {
    expect(qualityFromScore(1)).toBe(5);
    expect(qualityFromScore(0.7)).toBe(3);
    expect(qualityFromScore(0)).toBe(0);
  });

  it("updates mastery as a bounded moving average", () => {
    const m1 = updateMastery(0, 1, 1);
    expect(m1).toBeGreaterThan(0.5);
    const m2 = updateMastery(m1, 0, 2);
    expect(m2).toBeLessThan(m1);
    expect(m2).toBeGreaterThanOrEqual(0);
  });
});

describe("quiz grading", () => {
  it("grades multiple choice exactly", () => {
    expect(gradeAnswer("multiple-choice", "B) Paris", "b) paris")).toBe(true);
    expect(gradeAnswer("multiple-choice", "A) London", "B) Paris")).toBe(false);
  });

  it("grades short answers by key-token coverage", () => {
    expect(
      gradeAnswer(
        "short-answer",
        "It means spreading study sessions over time with growing intervals",
        "Spreading study sessions over increasing intervals of time"
      )
    ).toBe(true);
    expect(gradeAnswer("short-answer", "no idea", "Spreading study sessions over increasing intervals")).toBe(false);
    expect(gradeAnswer("short-answer", "", "anything")).toBe(false);
  });
});
