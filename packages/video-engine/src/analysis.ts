/**
 * Stage B: provider-neutral analysis of the NEUTRAL artifacts produced by
 * Stage A. This module never runs a provider itself — it prepares the exact,
 * capability-checked payload and honest task framing, so the caller can invoke
 * whichever provider the user chose. Splitting extraction from analysis is what
 * makes the engine work with Ollama / Codex / Gemini / Claude / OpenAI-compatible
 * / mock without any of them being required.
 */

export type AnalysisSegment = { index: number; startMs: number; endMs: number; speaker?: string; text: string };

export type VideoAnalysisTask =
  | "summary"
  | "claim-extraction"
  | "chapter-outline"
  | "key-quotes"
  | "topic-list";

export type AnalysisCapabilities = {
  textGeneration: boolean;
  imageInput?: boolean;
};

export type AnalysisPlan = {
  mode: "transcript-only" | "transcript-and-frames";
  usableFrames: number;
  /** Fenced, data-only transcript block for the prompt (untrusted content). */
  transcriptBlock: string;
  /** Honest scope note surfaced to the user AND embedded in the prompt. */
  scopeNote: string;
  /** Present only when the model genuinely accepts image input. */
  framePaths: string[];
};

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Build a capability-honest analysis plan. Returns a `blocked` reason instead
 * of a plan when the request cannot be satisfied truthfully — the caller then
 * offers another provider or transcript-only mode (never a silent switch).
 */
export function planVideoAnalysis(input: {
  segments: AnalysisSegment[];
  framePaths: string[];
  wantFrames: boolean;
  capabilities: AnalysisCapabilities;
}): { plan: AnalysisPlan } | { blocked: string } {
  if (!input.capabilities.textGeneration) return { blocked: "The selected provider cannot generate text." };
  if (input.segments.length === 0 && input.framePaths.length === 0) {
    return { blocked: "This video has no transcript segments and no frames to analyze." };
  }

  // Frames are ONLY included when the provider explicitly declares image input.
  const canSeeFrames = input.wantFrames && input.capabilities.imageInput === true && input.framePaths.length > 0;

  const transcriptBlock =
    input.segments.length > 0
      ? input.segments.map((s) => `[${clock(s.startMs)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`).join("\n")
      : "(no transcript available for this video)";

  let scopeNote: string;
  if (canSeeFrames) {
    scopeNote = `Analysis uses the transcript (${input.segments.length} segments) AND ${input.framePaths.length} extracted frames. Only these were processed — do not describe unseen portions.`;
  } else if (input.wantFrames && input.framePaths.length > 0) {
    scopeNote = `The selected model is TEXT-ONLY, so ${input.framePaths.length} extracted frame(s) were NOT analyzed — this is a transcript-only analysis. Never claim to have viewed the video.`;
  } else {
    scopeNote = `Transcript-only analysis of ${input.segments.length} segment(s). No frames were processed; never claim to have watched the video.`;
  }

  return {
    plan: {
      mode: canSeeFrames ? "transcript-and-frames" : "transcript-only",
      usableFrames: canSeeFrames ? input.framePaths.length : 0,
      transcriptBlock,
      scopeNote,
      framePaths: canSeeFrames ? input.framePaths : [],
    },
  };
}

const TASK_INSTRUCTIONS: Record<VideoAnalysisTask, string> = {
  summary: "Summarize what the transcript establishes, in 4-8 sentences. Cite timestamps like [12:03] for specific points.",
  "claim-extraction": "Extract the distinct factual claims made in the transcript. For each, quote the supporting line and its timestamp. Do not invent claims not present.",
  "chapter-outline": "Produce a chapter outline with start timestamps and short titles, based only on transcript content.",
  "key-quotes": "List the most important verbatim quotes with their timestamps. Copy them exactly; never paraphrase inside quotation marks.",
  "topic-list": "List the topics covered, each with the timestamp range where it is discussed.",
};

/** Assemble the trusted instruction text for a task, embedding the scope note. */
export function analysisInstructions(task: VideoAnalysisTask, plan: AnalysisPlan): string {
  return [
    `You are analyzing a video's extracted artifacts. ${plan.scopeNote}`,
    TASK_INSTRUCTIONS[task],
    "Use ONLY the fenced transcript below as source material. Preserve numbers, names, and timestamps exactly. If the transcript does not support something, say so instead of guessing.",
  ].join("\n\n");
}
