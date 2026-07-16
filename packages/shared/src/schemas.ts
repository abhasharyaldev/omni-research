import { z } from "zod";
import { PROJECT_MODES, PROVIDER_IDS } from "./types.js";

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(80),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const crawlLimitsSchema = z
  .object({
    maxConcurrency: z.number().int().positive(),
    maxPagesPerRun: z.number().int().positive(),
    maxPagesPerDomain: z.number().int().positive(),
    maxDepth: z.number().int().min(0),
    requestTimeoutMs: z.number().int().positive(),
    maxResponseBytes: z.number().int().positive(),
    defaultDelayMs: z.number().int().min(0),
    maxRetries: z.number().int().min(0),
    maxRedirects: z.number().int().min(0),
    maxTotalBytes: z.number().int().positive(),
    maxRunDurationMs: z.number().int().positive(),
  })
  .partial();

export const projectModeSchema = z.enum(PROJECT_MODES as [string, ...string[]]);
export const providerIdSchema = z.enum(PROVIDER_IDS as [string, ...string[]]);
export const citationStyleSchema = z.enum(["apa", "mla", "chicago", "web"]);

const urlListSchema = z.array(z.string().trim().url().max(2000)).max(100);
const domainListSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/, "must be a domain like example.com or *.example.com")
  )
  .max(200);

export const createProjectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  mode: projectModeSchema,
  prompt: z.string().trim().min(1).max(20_000),
  topics: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  gradeLevel: z.string().trim().max(80).optional(),
  expertiseLevel: z.string().trim().max(80).optional(),
  audience: z.string().trim().max(200).optional(),
  region: z.string().trim().max(120).optional(),
  dateRangeStart: z.coerce.date().optional(),
  dateRangeEnd: z.coerce.date().optional(),
  maxSources: z.number().int().min(1).max(100).optional(),
  citationStyle: citationStyleSchema.default("web"),
  outputFormat: z.string().trim().max(120).optional(),
  startingUrls: urlListSchema.default([]),
  includeDomains: domainListSchema.default([]),
  excludeDomains: domainListSchema.default([]),
  assignmentInstructions: z.string().trim().max(50_000).optional(),
  rubric: z.string().trim().max(50_000).optional(),
  crawlLimits: crawlLimitsSchema.optional(),
  provider: providerIdSchema.optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const startRunSchema = z.object({
  planOverrides: z
    .object({
      subquestions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
      excludeDomains: domainListSchema.optional(),
      crawlLimits: crawlLimitsSchema.optional(),
    })
    .optional(),
  /** From an approved run preview: crawl exactly these URLs as the first wave. */
  approvedUrls: z.array(z.string().trim().url().max(2000)).max(300).optional(),
  /** URLs the user explicitly removed in the preview. */
  excludedUrls: z.array(z.string().trim().url().max(2000)).max(300).optional(),
  /** Extra domains excluded for this run only. */
  excludeDomains: domainListSchema.optional(),
  /** Plan generated during preview so the run does not regenerate it. */
  planJson: z
    .object({
      mainQuestion: z.string().min(1).max(500),
      subquestions: z.array(z.string().min(1).max(500)).min(1).max(30),
      keyTerms: z.array(z.string().max(80)).max(30).default([]),
      discoveryQueries: z.array(z.string().max(200)).max(30).default([]),
      sourceCategories: z.array(z.string().max(60)).max(15).default([]),
      outline: z.array(z.string().max(200)).max(30).default([]),
    })
    .optional(),
  /** 0 disables the follow-up reasoning loop; clamped server-side to 0..4. */
  maxResearchTurns: z.number().int().min(0).max(4).optional(),
  /** Preview-only knobs applied to this run. */
  maxSources: z.number().int().min(1).max(100).optional(),
  highQualityOnly: z.boolean().optional(),
  excludeOpinion: z.boolean().optional(),
});

export const previewRunSchema = z.object({
  maxSources: z.number().int().min(1).max(100).optional(),
  crawlLimits: crawlLimitsSchema.optional(),
  excludeDomains: domainListSchema.optional(),
  extraUrls: z.array(z.string().trim().url().max(2000)).max(100).optional(),
  // Force a fresh plan (skip the in-memory plan cache). Wired to the dialog's
  // "Rebuild preview" button so a user who edited project settings can force
  // regeneration; ordinary re-previews reuse the cached plan and stay instant.
  forceReplan: z.boolean().optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(300),
  types: z.string().trim().max(200).optional(), // comma-separated SearchHitType list
  projectId: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minQuality: z.coerce.number().int().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const addSourceSchema = z.object({
  url: z.string().trim().url().max(2000),
  note: z.string().trim().max(2000).optional(),
});

export const createLearningPlanSchema = z.object({
  projectId: z.string().min(1),
  subject: z.string().trim().min(1).max(200),
  kind: z.enum(["school-subject", "practical-skill"]),
  currentLevel: z.string().trim().max(200).default("beginner"),
  targetLevel: z.string().trim().max(200).default("proficient"),
  deadline: z.coerce.date().optional(),
  hoursPerWeek: z.number().min(0.5).max(80).default(5),
  knownTopics: z.array(z.string().trim().max(200)).max(50).default([]),
  difficultTopics: z.array(z.string().trim().max(200)).max(50).default([]),
  learningStyle: z.string().trim().max(200).optional(),
});

export const quizSubmitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        answer: z.string().trim().max(4000),
      })
    )
    .min(1)
    .max(100),
});

export const exportSchema = z.object({
  format: z.enum(["markdown", "html", "json", "csv-sources", "csv-flashcards", "bibliography", "docx", "pdf"]),
  citationStyle: citationStyleSchema.optional(),
});

export const factCheckSchema = z.object({
  claims: z.array(z.string().trim().min(3).max(2000)).min(1).max(20),
  urls: urlListSchema.default([]),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateLearningPlanInput = z.infer<typeof createLearningPlanSchema>;
