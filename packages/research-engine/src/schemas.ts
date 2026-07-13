import { z } from "zod";

/** Structured-output contracts between the engines and AI providers. */

export const planOutputSchema = z.object({
  mainQuestion: z.string().min(1).max(500),
  subquestions: z.array(z.string().min(1).max(500)).min(1).max(30),
  keyTerms: z.array(z.string().max(80)).max(30).default([]),
  discoveryQueries: z.array(z.string().max(200)).max(30).default([]),
  sourceCategories: z.array(z.string().max(60)).max(15).default([]),
  outline: z.array(z.string().max(200)).max(30).default([]),
});
export type PlanOutput = z.infer<typeof planOutputSchema>;

export const PLAN_SCHEMA_DESCRIPTION = `{
  "mainQuestion": "string",
  "subquestions": ["string"],
  "keyTerms": ["string"],
  "discoveryQueries": ["string"],
  "sourceCategories": ["string"],
  "outline": ["string"]
}`;

export const evidenceOutputSchema = z.object({
  evidence: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        claim: z.string().min(1).max(600),
        evidenceText: z.string().min(1).max(1200),
        subquestionIndex: z.number().int().min(0).optional(),
        relevanceScore: z.number().min(0).max(1).default(0.5),
        evidenceStrength: z.enum(["strong", "moderate", "weak"]).default("moderate"),
        evidenceType: z
          .enum(["data", "quote", "finding", "definition", "example", "opinion", "prediction", "historical-record"])
          .default("finding"),
      })
    )
    .max(200),
});
export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;

export const EVIDENCE_SCHEMA_DESCRIPTION = `{
  "evidence": [{
    "sourceId": "string (copy exactly from the source header)",
    "claim": "string — the factual claim this excerpt supports, in your words",
    "evidenceText": "string — an EXACT VERBATIM sentence copied from the source material. Never paraphrase here.",
    "subquestionIndex": 0,
    "relevanceScore": 0.0,
    "evidenceStrength": "strong|moderate|weak",
    "evidenceType": "data|quote|finding|definition|example|opinion|prediction|historical-record"
  }]
}`;

export const synthesisOutputSchema = z.object({
  sections: z
    .array(
      z.object({
        kind: z.string().max(40).default("body"),
        title: z.string().min(1).max(300),
        contentMd: z.string().min(1).max(40_000),
      })
    )
    .min(1)
    .max(40),
});
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

export const SYNTHESIS_SCHEMA_DESCRIPTION = `{
  "sections": [{
    "kind": "executive-summary|findings|background|analysis|comparison|statistics|perspectives|timeline|limitations|open-questions|conclusion|body",
    "title": "string",
    "contentMd": "markdown. Cite evidence with bracketed markers like [1][2] that refer ONLY to the numbered evidence list you were given. Never invent a marker number."
  }]
}`;

export const factCheckOutputSchema = z.object({
  verdicts: z
    .array(
      z.object({
        claimIndex: z.number().int().min(0),
        status: z.enum([
          "well-supported",
          "mostly-supported",
          "partially-supported",
          "disputed",
          "weakly-supported",
          "unsupported",
          "outdated",
          "unable-to-verify",
        ]),
        explanation: z.string().min(1).max(4000),
      })
    )
    .max(50),
});
export type FactCheckOutput = z.infer<typeof factCheckOutputSchema>;

export const FACT_CHECK_SCHEMA_DESCRIPTION = `{
  "verdicts": [{ "claimIndex": 0, "status": "well-supported|mostly-supported|partially-supported|disputed|weakly-supported|unsupported|outdated|unable-to-verify", "explanation": "string" }]
}`;

export const gapAnalysisOutputSchema = z.object({
  gaps: z
    .array(
      z.object({
        subquestionIndex: z.number().int().min(0),
        reason: z.string().min(1).max(500),
      })
    )
    .max(20)
    .default([]),
  followupQueries: z.array(z.string().min(2).max(200)).max(10).default([]),
  /** True when the provider judges evidence coverage sufficient to stop. */
  coverageSufficient: z.boolean().default(false),
  decisionNote: z.string().max(600).default(""),
});
export type GapAnalysisOutput = z.infer<typeof gapAnalysisOutputSchema>;

export const GAP_ANALYSIS_SCHEMA_DESCRIPTION = `{
  "gaps": [{ "subquestionIndex": 0, "reason": "why this subquestion lacks evidence" }],
  "followupQueries": ["specific search query that could fill a gap"],
  "coverageSufficient": false,
  "decisionNote": "one concise sentence explaining the decision (no hidden reasoning)"
}`;

export const reconciliationOutputSchema = z.object({
  disagreements: z
    .array(
      z.object({
        pairIndex: z.number().int().min(0),
        topic: z.string().min(1).max(300),
        conflictPoint: z.string().min(1).max(1000),
        kind: z.enum(["factual", "interpretation", "methodology", "timing"]).default("factual"),
        resolution: z.enum(["superseded-by-newer", "prefer-primary-source", "methodological-difference", "unresolved"]).default("unresolved"),
        assessment: z.string().min(1).max(2000),
        confidenceNote: z.string().max(500).default(""),
      })
    )
    .max(20)
    .default([]),
});
export type ReconciliationOutput = z.infer<typeof reconciliationOutputSchema>;

export const RECONCILIATION_SCHEMA_DESCRIPTION = `{
  "disagreements": [{
    "pairIndex": 0,
    "topic": "what both excerpts are about",
    "conflictPoint": "the exact point on which the excerpts disagree",
    "kind": "factual|interpretation|methodology|timing",
    "resolution": "superseded-by-newer|prefer-primary-source|methodological-difference|unresolved",
    "assessment": "honest assessment; if the conflict cannot be resolved from the given excerpts, say so plainly",
    "confidenceNote": "state uncertainty explicitly"
  }]
}`;

export const newsSummariesOutputSchema = z.object({
  events: z
    .array(
      z.object({
        clusterIndex: z.number().int().min(0),
        headline: z.string().min(1).max(300),
        summaryMd: z.string().min(1).max(8000),
        whyItMatters: z.string().max(4000).optional(),
        whatChanged: z.string().max(4000).optional(),
        confidence: z.enum(["low", "medium", "high"]).default("medium"),
      })
    )
    .max(60),
});
export type NewsSummariesOutput = z.infer<typeof newsSummariesOutputSchema>;

export const NEWS_SCHEMA_DESCRIPTION = `{
  "events": [{ "clusterIndex": 0, "headline": "string", "summaryMd": "markdown", "whyItMatters": "string", "whatChanged": "string", "confidence": "low|medium|high" }]
}`;
