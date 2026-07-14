import { describe, expect, it } from "vitest";
import { buildWatchArgs, isHttpUrl, HARD_MAX_FRAMES } from "../src/args.js";
import { planVideoAnalysis, analysisInstructions } from "../src/analysis.js";
import { parseWatchTranscript } from "../src/extract.js";
import { detectVideoEngine, CLAUDE_VIDEO_PIN } from "../src/detection.js";

const SCRIPT = "/x/watch.py";

describe("buildWatchArgs (safe fixed template)", () => {
  it("blocks SSRF / private-network video URLs", () => {
    expect(() => buildWatchArgs(SCRIPT, { source: "http://169.254.169.254/latest", outDir: "/tmp/o" })).toThrow(/safety policy/i);
    expect(() => buildWatchArgs(SCRIPT, { source: "http://127.0.0.1/v.mp4", outDir: "/tmp/o" })).toThrow(/safety policy/i);
  });

  it("rejects local files from the browser and dash-prefixed sources", () => {
    expect(() => buildWatchArgs(SCRIPT, { source: "/etc/passwd", outDir: "/tmp/o" })).toThrow(/local files/i);
    expect(() => buildWatchArgs(SCRIPT, { source: "--evil", outDir: "/tmp/o", allowLocalFile: true })).toThrow(/Invalid local video path/);
  });

  it("transcript mode requests no frames", () => {
    const { args, framesRequested } = buildWatchArgs(SCRIPT, { source: "https://youtube.com/watch?v=x", outDir: "/tmp/o", detailMode: "transcript" });
    expect(framesRequested).toBe(false);
    expect(args).toContain("--no-whisper");
    expect(args).toEqual(expect.arrayContaining(["https://youtube.com/watch?v=x", "--out-dir", "/tmp/o", "--max-frames", "1"]));
  });

  it("clamps frames to the hard maximum and the mode cap", () => {
    const burner = buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", detailMode: "token-burner", maxFrames: 9999 });
    expect(burner.maxFrames).toBeLessThanOrEqual(HARD_MAX_FRAMES);
    const efficient = buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", detailMode: "efficient", maxFrames: 9999 });
    expect(efficient.maxFrames).toBe(24);
  });

  it("validates start/end windows", () => {
    expect(() => buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", startSec: -1 })).toThrow(/non-negative/);
    expect(() => buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", startSec: 10, endSec: 5 })).toThrow(/greater than/);
    const ok = buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", startSec: 60, endSec: 120 });
    expect(ok.args).toEqual(expect.arrayContaining(["--start", "00:01:00", "--end", "00:02:00"]));
  });

  it("only forwards remote whisper when explicitly opted in", () => {
    const def = buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o" });
    expect(def.args).toContain("--no-whisper");
    const optIn = buildWatchArgs(SCRIPT, { source: "https://v.example/a", outDir: "/tmp/o", noWhisper: false });
    expect(optIn.args).not.toContain("--no-whisper");
  });

  it("recognizes http(s) sources", () => {
    expect(isHttpUrl("https://x.com")).toBe(true);
    expect(isHttpUrl("/local/path")).toBe(false);
  });
});

describe("parseWatchTranscript", () => {
  it("parses timestamped transcript lines into neutral segments", () => {
    const out = `[watch] done
transcript source: captions
[00:00:01] Alice: First point here.
[00:00:05 --> 00:00:08] Second point.`;
    const { segments, source } = parseWatchTranscript(out);
    expect(source).toBe("captions");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ startMs: 1000, speaker: "Alice", text: "First point here." });
    expect(segments[1]).toMatchObject({ startMs: 5000, endMs: 8000, text: "Second point." });
  });
});

describe("planVideoAnalysis (capability gating)", () => {
  const segments = [{ index: 0, startMs: 0, endMs: 2000, text: "Spacing beats cramming." }];

  it("text-only model never receives frames and is told so honestly", () => {
    const result = planVideoAnalysis({ segments, framePaths: ["f0.png", "f1.png"], wantFrames: true, capabilities: { textGeneration: true, imageInput: false } });
    expect("plan" in result).toBe(true);
    if ("plan" in result) {
      expect(result.plan.mode).toBe("transcript-only");
      expect(result.plan.usableFrames).toBe(0);
      expect(result.plan.framePaths).toHaveLength(0);
      expect(result.plan.scopeNote).toMatch(/TEXT-ONLY|never claim/i);
    }
  });

  it("multimodal model receives frames only when it declares image input", () => {
    const result = planVideoAnalysis({ segments, framePaths: ["f0.png"], wantFrames: true, capabilities: { textGeneration: true, imageInput: true } });
    if ("plan" in result) {
      expect(result.plan.mode).toBe("transcript-and-frames");
      expect(result.plan.framePaths).toHaveLength(1);
    } else {
      throw new Error("expected a plan");
    }
  });

  it("blocks when the provider cannot generate text", () => {
    const result = planVideoAnalysis({ segments, framePaths: [], wantFrames: false, capabilities: { textGeneration: false } });
    expect("blocked" in result).toBe(true);
  });

  it("embeds the honest scope note into task instructions", () => {
    const result = planVideoAnalysis({ segments, framePaths: [], wantFrames: false, capabilities: { textGeneration: true } });
    if ("plan" in result) {
      const instr = analysisInstructions("summary", result.plan);
      expect(instr).toMatch(/never claim to have watched/i);
      expect(instr).toMatch(/Summarize/);
    }
  });
});

describe("detectVideoEngine", () => {
  it("reports a stable pin and always allows caption import", () => {
    const status = detectVideoEngine();
    expect(status.pin).toBe(CLAUDE_VIDEO_PIN);
    expect(status.captionImportAlways).toBe(true);
    expect(typeof status.reason).toBe("string");
  });
});
