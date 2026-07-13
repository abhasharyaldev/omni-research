import { z } from "zod";

/** Storytelling modes users can pick (plus "auto"). */
export const STORY_MODES = [
  "auto",
  "documentary",
  "investigative",
  "historical-narrative",
  "mystery",
  "rise-and-fall",
  "discovery-story",
  "invention-story",
  "case-study",
  "news-explainer",
  "educational-story",
  "problem-and-solution",
  "transformation",
  "timeline",
  "conflict-and-resolution",
  "myth-versus-reality",
  "human-interest",
  "technical-breakdown",
  "fast-short-form",
  "calm-long-form",
] as const;
export type StoryMode = (typeof STORY_MODES)[number];

export const STORY_FRAMEWORKS = [
  "three-act",
  "hook-context-escalation-payoff",
  "mystery",
  "investigative",
  "rise-and-fall",
  "problem-and-solution",
  "timeline",
  "transformation",
  "plain-explanation",
] as const;
export type StoryFramework = (typeof STORY_FRAMEWORKS)[number];

export const STORY_PLATFORMS = ["youtube-long", "youtube-short", "tiktok", "reels", "podcast", "generic"] as const;

export const createStorySchema = z.object({
  mode: z.enum(STORY_MODES).default("auto"),
  platform: z.enum(STORY_PLATFORMS).default("youtube-long"),
  targetDurationSec: z.number().int().min(15).max(3600).default(480),
  audience: z.string().trim().max(200).default("general audience"),
  tone: z.string().trim().max(100).default("clear and engaging"),
  pace: z.enum(["calm", "moderate", "fast"]).default("moderate"),
  suspense: z.enum(["low", "medium", "high"]).default("medium"),
  technicalDepth: z.enum(["beginner", "intermediate", "expert"]).default("beginner"),
  humor: z.enum(["none", "light", "playful"]).default("none"),
  emotionalLevel: z.enum(["low", "medium", "high"]).default("medium"),
  narration: z.enum(["first-person", "third-person"]).default("third-person"),
  delivery: z.enum(["documentary", "conversational"]).default("conversational"),
  keepOpenQuestions: z.boolean().default(true),
  citationVisibility: z.enum(["inline", "end-card", "hidden-in-description"]).default("inline"),
});
export type StorySettings = z.infer<typeof createStorySchema>;

// ---------------------------------------------------------------------------
// Structured artifact contracts (provider outputs)
// ---------------------------------------------------------------------------

/** Every factual element must reference evidence markers ("E3" = evidence index 3). */
const evidenceRefs = z.array(z.string().max(12)).max(20).default([]);

export const blueprintSchema = z.object({
  framework: z.enum(STORY_FRAMEWORKS),
  frameworkReason: z.string().min(1).max(1000),
  centralQuestion: z.string().min(1).max(500),
  viewerPromise: z.string().min(1).max(500),
  mainSubject: z.string().min(1).max(300),
  mainConflict: z.string().min(1).max(600),
  stakes: z.string().max(600).default(""),
  setting: z.string().max(600).default(""),
  people: z.array(z.object({ name: z.string().max(200), role: z.string().max(300), evidenceRefs })).max(15).default([]),
  startingSituation: z.object({ text: z.string().max(1000), evidenceRefs }),
  triggeringEvent: z.object({ text: z.string().max(1000), evidenceRefs }),
  escalation: z.array(z.object({ text: z.string().max(800), evidenceRefs })).max(10).default([]),
  turningPoints: z.array(z.object({ text: z.string().max(800), evidenceRefs })).max(10).default([]),
  keyDiscoveries: z.array(z.object({ text: z.string().max(800), evidenceRefs })).max(10).default([]),
  contradictions: z.array(z.object({ text: z.string().max(800), evidenceRefs })).max(10).default([]),
  climax: z.object({ text: z.string().max(1000), evidenceRefs }),
  resolution: z.object({ text: z.string().max(1000), evidenceRefs }),
  remainingUncertainty: z.string().max(1000).default(""),
  mainLesson: z.string().max(600).default(""),
  finalTakeaway: z.string().min(1).max(600),
  callToAction: z.string().max(300).default(""),
  storyLens: z.string().max(600).default(""),
});
export type StoryBlueprint = z.infer<typeof blueprintSchema>;

export const BLUEPRINT_SCHEMA_DESCRIPTION = `{
  "framework": "three-act|hook-context-escalation-payoff|mystery|investigative|rise-and-fall|problem-and-solution|timeline|transformation|plain-explanation",
  "frameworkReason": "why this structure fits the topic/evidence/audience (shown to the user)",
  "centralQuestion": "string", "viewerPromise": "string", "mainSubject": "string", "mainConflict": "string",
  "stakes": "string", "setting": "string",
  "people": [{"name":"string","role":"string","evidenceRefs":["E1"]}],
  "startingSituation": {"text":"string","evidenceRefs":["E1"]},
  "triggeringEvent": {"text":"string","evidenceRefs":["E2"]},
  "escalation": [{"text":"string","evidenceRefs":["E3"]}],
  "turningPoints": [{"text":"string","evidenceRefs":[]}],
  "keyDiscoveries": [{"text":"string","evidenceRefs":[]}],
  "contradictions": [{"text":"string","evidenceRefs":[]}],
  "climax": {"text":"string","evidenceRefs":[]},
  "resolution": {"text":"string","evidenceRefs":[]},
  "remainingUncertainty": "string", "mainLesson": "string", "finalTakeaway": "string",
  "callToAction": "string", "storyLens": "the unique angle chosen (see skill instructions)"
}
Every evidenceRefs entry must be an ID from the EVIDENCE section (e.g. "E4"). Never invent one.`;

export const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        purpose: z.string().max(500).default(""),
        beats: z
          .array(
            z.object({
              text: z.string().min(1).max(800),
              connector: z.enum(["opening", "but", "therefore"]).default("therefore"),
              evidenceRefs,
              kind: z.enum(["fact", "reported-claim", "interpretation", "inference", "speculation", "transition", "question"]).default("fact"),
            })
          )
          .min(1)
          .max(20),
        estimatedSeconds: z.number().int().min(3).max(1200).default(30),
      })
    )
    .min(1)
    .max(30),
  retentionPlan: z
    .array(z.object({ technique: z.string().max(200), placement: z.string().max(300), payoffAt: z.string().max(300), informationUsed: z.string().max(300) }))
    .max(12)
    .default([]),
});
export type StoryOutline = z.infer<typeof outlineSchema>;

export const OUTLINE_SCHEMA_DESCRIPTION = `{
  "sections": [{
    "title": "string", "purpose": "string",
    "beats": [{"text":"string","connector":"opening|but|therefore","evidenceRefs":["E1"],"kind":"fact|reported-claim|interpretation|inference|speculation|transition|question"}],
    "estimatedSeconds": 30
  }],
  "retentionPlan": [{"technique":"string","placement":"string","payoffAt":"string","informationUsed":"string"}]
}
Beats follow the skill's Dance rule: connect with but/therefore, never "and then". Factual beats need evidenceRefs; label anything not directly supported as inference/speculation.`;

export const hooksSchema = z.object({
  hooks: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        type: z.enum(["mystery", "contrast", "question", "stakes", "historical-moment", "discovery", "belief-challenged", "character", "visual", "cold-open"]),
        intendedEmotion: z.string().max(100).default("curiosity"),
        factualBasis: z.string().max(500).default(""),
        evidenceRefs,
        audienceFit: z.string().max(400).default(""),
        exaggerationRisk: z.enum(["none", "low", "medium", "high"]).default("low"),
        saferAlternative: z.string().max(500).default(""),
      })
    )
    .min(1)
    .max(12),
});
export type StoryHooks = z.infer<typeof hooksSchema>;

export const HOOKS_SCHEMA_DESCRIPTION = `{
  "hooks": [{
    "text":"string","type":"mystery|contrast|question|stakes|historical-moment|discovery|belief-challenged|character|visual|cold-open",
    "intendedEmotion":"string","factualBasis":"the claim the hook rests on","evidenceRefs":["E1"],
    "audienceFit":"why it fits","exaggerationRisk":"none|low|medium|high","saferAlternative":"required when risk is medium/high"
  }]
}
Never invent danger/controversy, misrepresent scale, use unsupported superlatives, call public things secret, present rumors as confirmed, create fake urgency, distort quotes, or promise answers the research cannot deliver.`;

export const scenesSchema = z.object({
  scenes: z
    .array(
      z.object({
        goal: z.string().min(1).max(400),
        narration: z.string().min(1).max(3000),
        mainClaim: z.string().max(600).default(""),
        evidenceRefs,
        visualSuggestion: z.string().max(600).default(""),
        visualSourceNote: z.string().max(300).default(""),
        emotionalPurpose: z.string().max(200).default(""),
        transition: z.string().max(300).default(""),
        estimatedSeconds: z.number().int().min(3).max(1200).default(20),
        confidence: z.enum(["high", "medium", "low"]).default("medium"),
        accuracyWarning: z.string().max(400).default(""),
        needsMoreResearch: z.boolean().default(false),
      })
    )
    .min(1)
    .max(60),
});
export type StoryScenes = z.infer<typeof scenesSchema>;

export const SCENES_SCHEMA_DESCRIPTION = `{
  "scenes": [{
    "goal":"string","narration":"spoken narration","mainClaim":"string","evidenceRefs":["E1"],
    "visualSuggestion":"prefer archive material, public-domain visuals, maps, diagrams, timelines, data viz, screen recordings, B-roll, motion graphics, text animation",
    "visualSourceNote":"license note — never present copyrighted footage as freely reusable",
    "emotionalPurpose":"string","transition":"string","estimatedSeconds":20,
    "confidence":"high|medium|low","accuracyWarning":"string","needsMoreResearch":false
  }]
}`;

export const scriptSchema = z.object({
  title: z.string().min(1).max(300),
  lines: z
    .array(
      z.object({
        text: z.string().min(1).max(1500),
        kind: z.enum(["hook", "narration", "transition", "reveal", "takeaway", "cta"]).default("narration"),
        statement: z.enum(["fact", "reported-claim", "interpretation", "inference", "speculation", "opinion", "unknown", "non-factual"]).default("non-factual"),
        evidenceRefs,
        sceneIndex: z.number().int().min(0).optional(),
      })
    )
    .min(3)
    .max(400),
  estimatedWords: z.number().int().min(10).default(100),
  estimatedSeconds: z.number().int().min(10).default(60),
});
export type StoryScript = z.infer<typeof scriptSchema>;

export const SCRIPT_SCHEMA_DESCRIPTION = `{
  "title": "string (accurate, not clickbait)",
  "lines": [{
    "text":"one spoken sentence per line (the skill's Rhythm rule — vary lengths, jagged edge)",
    "kind":"hook|narration|transition|reveal|takeaway|cta",
    "statement":"fact|reported-claim|interpretation|inference|speculation|opinion|unknown|non-factual",
    "evidenceRefs":["E1"], "sceneIndex":0
  }],
  "estimatedWords": 100,
  "estimatedSeconds": 60
}
Spoken delivery ≈ 2 words/second — write to the requested runtime. Every line whose statement is fact/reported-claim MUST carry evidenceRefs; never promote an inference to fact for drama.`;

export const critiqueSchema = z.object({
  findings: z
    .array(
      z.object({
        category: z.enum([
          "weak-hook", "slow-pacing", "missing-context", "repetition", "unclear-stakes", "weak-transition",
          "unsupported-drama", "delayed-payoff", "incomplete-resolution", "audience-relevance", "confusing-chronology",
          "jargon", "weak-visuals", "and-then-beat", "flat-rhythm", "performed-tone", "weak-last-dab", "obvious-lens",
        ]),
        offendingLine: z.string().max(1500).default(""),
        lineIndex: z.number().int().min(0).optional(),
        problem: z.string().min(1).max(800),
        suggestedRevision: z.string().max(1500).default(""),
      })
    )
    .max(40)
    .default([]),
  overallAssessment: z.string().min(1).max(2000),
});
export type StoryCritique = z.infer<typeof critiqueSchema>;

export const CRITIQUE_SCHEMA_DESCRIPTION = `{
  "findings": [{"category":"weak-hook|slow-pacing|missing-context|repetition|unclear-stakes|weak-transition|unsupported-drama|delayed-payoff|incomplete-resolution|audience-relevance|confusing-chronology|jargon|weak-visuals|and-then-beat|flat-rhythm|performed-tone|weak-last-dab|obvious-lens","offendingLine":"quote the exact line","lineIndex":0,"problem":"string","suggestedRevision":"revision that preserves verified facts and citations"}],
  "overallAssessment": "string"
}`;

// ---------------------------------------------------------------------------
// Automatic mode selection
// ---------------------------------------------------------------------------

/**
 * Deterministic auto-mode: picks a structure from the evidence shape and
 * explains why. Never forces drama onto topics better served by a plain
 * explanation.
 */
export function autoSelectMode(input: {
  prompt: string;
  disputedCount: number;
  eventDates: number;
  peopleMentioned: boolean;
  platform: string;
  targetDurationSec: number;
}): { mode: StoryMode; framework: StoryFramework; reason: string } {
  const short = input.targetDurationSec <= 90 || ["tiktok", "reels", "youtube-short"].includes(input.platform);
  const p = input.prompt.toLowerCase();
  if (short) {
    return {
      mode: "fast-short-form",
      framework: "hook-context-escalation-payoff",
      reason: `Target runtime is ${input.targetDurationSec}s on ${input.platform}: the compressed hook → context → escalation → payoff structure fits; complex disputes are flagged rather than compressed into a misleading claim.`,
    };
  }
  if (input.disputedCount >= 2) {
    return {
      mode: "investigative",
      framework: "investigative",
      reason: `The research package contains ${input.disputedCount} disputed claims, so an investigative structure (claim → supporting evidence → challenging evidence → credibility → defensible conclusion) presents the conflict honestly instead of hiding it.`,
    };
  }
  if (/history|历史|ancient|war|empire|century|revolution/.test(p) || input.eventDates >= 5) {
    return {
      mode: "historical-narrative",
      framework: "timeline",
      reason: `The evidence carries ${input.eventDates} dated events, so a chronological structure (beginning → developments → turning points → today) is the clearest honest fit.`,
    };
  }
  if (/how|why|explain|what is|works?/.test(p) && !input.peopleMentioned) {
    return {
      mode: "educational-story",
      framework: "plain-explanation",
      reason: "The topic is explanatory and not people-driven; a clear explanation beats a forced dramatic arc (the skill warns against manufacturing drama).",
    };
  }
  return {
    mode: "documentary",
    framework: "three-act",
    reason: "General topic with solid evidence coverage: a documentary three-act structure (setup → confrontation → resolution) balances engagement and accuracy.",
  };
}
