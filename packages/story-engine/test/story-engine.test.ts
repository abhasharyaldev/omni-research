import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectSkill, detectStorytellingSkills } from "../src/skill-detection.js";
import { autoSelectMode } from "../src/schemas.js";
import { validateScript, vetHooks } from "../src/validation.js";
import type { ResearchPackage } from "../src/research-package.js";

// ---------------------------------------------------------------------------
// Skill detection (uses a temp project dir so tests never depend on the
// machine's real user-level skills)
// ---------------------------------------------------------------------------

let tempRoot: string;

beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "omni-skill-test-"));
  const dir = path.join(tempRoot, ".claude", "skills", "storytelling");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: storytelling\ndescription: test skill\n---\n\n# Storytelling\nUse but/therefore beats.\n`
  );
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("skill detection", () => {
  it("detects a project-level skill and records name, instructions, and hash", () => {
    const skill = detectSkill("storytelling", tempRoot);
    expect(skill).toBeTruthy();
    expect(skill!.name).toBe("storytelling");
    expect(skill!.instructions).toContain("but/therefore");
    expect(skill!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(skill!.source).toBe("project");
  });

  it("returns null for a skill that is not installed", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "omni-noskill-"));
    process.env.OMNI_TEST_FAKE_HOME = "1"; // documentation only; detection uses real home for user level
    const skill = detectSkill("definitely-not-a-real-skill-xyz", empty);
    expect(skill).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it("reports searched paths and integration honestly", () => {
    const report = detectStorytellingSkills(tempRoot);
    expect(report.storytelling?.name).toBe("storytelling");
    expect(report.searchedPaths.length).toBe(2);
    expect(report.detectedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Auto mode selection
// ---------------------------------------------------------------------------

describe("automatic mode selection", () => {
  const base = { prompt: "", disputedCount: 0, eventDates: 0, peopleMentioned: false, platform: "youtube-long", targetDurationSec: 480 };

  it("picks short-form structure for short targets and explains why", () => {
    const pick = autoSelectMode({ ...base, targetDurationSec: 45, platform: "tiktok" });
    expect(pick.mode).toBe("fast-short-form");
    expect(pick.framework).toBe("hook-context-escalation-payoff");
    expect(pick.reason).toContain("45s");
  });

  it("picks investigative when disputes exist", () => {
    const pick = autoSelectMode({ ...base, disputedCount: 3 });
    expect(pick.mode).toBe("investigative");
    expect(pick.reason).toContain("disputed");
  });

  it("refuses to force drama onto explanatory topics", () => {
    const pick = autoSelectMode({ ...base, prompt: "How does spaced repetition work?" });
    expect(pick.framework).toBe("plain-explanation");
  });
});

// ---------------------------------------------------------------------------
// Script validation
// ---------------------------------------------------------------------------

const pkg: ResearchPackage = {
  projectId: "p",
  projectTitle: "T",
  prompt: "test",
  packageVersion: "abc123",
  evidence: [
    {
      ref: "E1",
      evidenceId: "ev1",
      claim: "Spaced repetition improves retention",
      excerpt: "Students who spread five hours of study across two weeks outperform students who cram.",
      sourceId: "s1",
      sourceTitle: "Journal",
      sourceUrl: "https://x",
      qualityScore: 70,
      classification: "educational-reference",
      isPrimarySource: false,
      confidence: "high",
      evidenceType: "finding",
      publishedAt: "2026-06-02T00:00:00.000Z",
    },
  ],
  disputedClaims: [{ text: "Cramming is equally effective for long-term retention", explanation: "sources disagree", evidenceRefs: ["E1"] }],
  unresolvedQuestions: [],
  prohibitedClaims: [],
  copyrightNote: "",
  safetyNote: "",
  eventDatesCount: 1,
  peopleMentioned: false,
};

const script = (lines: any[]) => ({ title: "Honest title", lines, estimatedWords: 50, estimatedSeconds: 25 });

describe("script validation", () => {
  it("passes a fully supported script", () => {
    const result = validateScript(pkg, script([
      { text: "What actually helps you remember?", kind: "hook", statement: "non-factual", evidenceRefs: [] },
      { text: "Spaced repetition improves retention.", kind: "narration", statement: "fact", evidenceRefs: ["E1"] },
      { text: "That is the takeaway.", kind: "takeaway", statement: "non-factual", evidenceRefs: [] },
    ]));
    expect(result.verdict).toBe("ready");
    expect(result.supportedLines).toBe(1);
  });

  it("flags factual lines without citations as high-risk", () => {
    const result = validateScript(pkg, script([
      { text: "Scientists proved memory is infinite.", kind: "narration", statement: "fact", evidenceRefs: [] },
      { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
    ]));
    expect(result.verdict).toBe("needs-review");
    expect(result.issues.some((i) => i.code === "missing-citation")).toBe(true);
  });

  it("rejects invented evidence references (invented citations)", () => {
    const result = validateScript(pkg, script([
      { text: "Spaced repetition improves retention.", kind: "narration", statement: "fact", evidenceRefs: ["E99"] },
      { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
    ]));
    expect(result.issues.some((i) => i.code === "unknown-evidence-ref" && i.severity === "high")).toBe(true);
  });

  it("catches altered numbers and unsupported years", () => {
    const result = validateScript(pkg, script([
      { text: "Students studied for 500 hours in 1875.", kind: "narration", statement: "fact", evidenceRefs: ["E1"] },
      { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
    ]));
    expect(result.issues.some((i) => i.code === "altered-number")).toBe(true);
    expect(result.issues.some((i) => i.code === "unsupported-year")).toBe(true);
  });

  it("catches invented quotations", () => {
    const result = validateScript(pkg, script([
      { text: 'One researcher said "memory is a muscle that never tires under any load".', kind: "narration", statement: "fact", evidenceRefs: ["E1"] },
      { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
    ]));
    expect(result.issues.some((i) => i.code === "invented-quote")).toBe(true);
  });

  it("flags sensational language and misleading titles", () => {
    const result = validateScript(pkg, {
      ...script([
        { text: "This shocking secret they don't want you to know.", kind: "hook", statement: "non-factual", evidenceRefs: [] },
        { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
        { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      ]),
      title: "The SHOCKING truth guaranteed to blow your mind",
    });
    expect(result.issues.filter((i) => i.code === "exaggerated-language").length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.code === "misleading-title")).toBe(true);
  });

  it("protects locked facts from silent removal", () => {
    const result = validateScript(
      pkg,
      script([
        { text: "An unrelated opening.", kind: "hook", statement: "non-factual", evidenceRefs: [] },
        { text: "b", kind: "narration", statement: "non-factual", evidenceRefs: [] },
        { text: "c", kind: "narration", statement: "non-factual", evidenceRefs: [] },
      ]),
      [{ evidenceRef: "E1", text: "Spaced repetition improves retention" }]
    );
    expect(result.issues.some((i) => i.code === "locked-fact-missing" && i.severity === "high")).toBe(true);
    expect(result.verdict).toBe("needs-review");
  });
});

describe("hook safety gate", () => {
  it("rejects hooks without evidence and sensational hooks; keeps grounded ones", () => {
    const { accepted, rejected } = vetHooks(pkg, {
      hooks: [
        { text: "Spaced repetition improves retention", type: "question", intendedEmotion: "curiosity", factualBasis: "", evidenceRefs: ["E1"], audienceFit: "", exaggerationRisk: "low", saferAlternative: "" },
        { text: "The shocking secret schools don't want you to know", type: "mystery", intendedEmotion: "fear", factualBasis: "", evidenceRefs: ["E1"], audienceFit: "", exaggerationRisk: "low", saferAlternative: "" },
        { text: "A hook with no evidence at all", type: "question", intendedEmotion: "curiosity", factualBasis: "", evidenceRefs: [], audienceFit: "", exaggerationRisk: "none", saferAlternative: "" },
      ],
    });
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });
});
