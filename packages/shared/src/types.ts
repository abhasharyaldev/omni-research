/** Core domain types shared across the OmniResearch monorepo. */

export type ProjectMode =
  | "deep-research"
  | "learn-subject"
  | "learn-skill"
  | "news-catchup"
  | "fact-check"
  | "school-project";

export const PROJECT_MODES: ProjectMode[] = [
  "deep-research",
  "learn-subject",
  "learn-skill",
  "news-catchup",
  "fact-check",
  "school-project",
];

export type ResearchRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "failed"
  | "completed";

/** Real pipeline stages. Progress events must reference one of these. */
export type ResearchStage =
  | "understanding-request"
  | "building-plan"
  | "generating-subquestions"
  | "discovering-sources"
  | "scoring-candidates"
  | "checking-url-safety"
  | "checking-robots"
  | "queuing-pages"
  | "crawling"
  | "extracting-content"
  | "deduplicating"
  | "classifying-sources"
  | "extracting-evidence"
  | "comparing-claims"
  | "identifying-gaps"
  | "following-up"
  | "reconciling-disagreements"
  | "writing-report"
  | "verifying-citations"
  | "complete";

export const RESEARCH_STAGES: ResearchStage[] = [
  "understanding-request",
  "building-plan",
  "generating-subquestions",
  "discovering-sources",
  "scoring-candidates",
  "checking-url-safety",
  "checking-robots",
  "queuing-pages",
  "crawling",
  "extracting-content",
  "deduplicating",
  "classifying-sources",
  "extracting-evidence",
  "comparing-claims",
  "identifying-gaps",
  "following-up",
  "reconciling-disagreements",
  "writing-report",
  "verifying-citations",
  "complete",
];

export type SkipReason =
  | "robots-disallowed"
  | "login-required"
  | "paywall-detected"
  | "unsupported-content-type"
  | "unsafe-url"
  | "private-network"
  | "domain-blocked"
  | "duplicate-url"
  | "duplicate-content"
  | "crawl-limit-reached"
  | "redirect-blocked"
  | "response-too-large"
  | "request-failed"
  | "rate-limited"
  | "cancelled";

export type DiscoveredBy =
  | "user"
  | "search-provider"
  | "page-link"
  | "rss"
  | "sitemap"
  | "citation";

/** Structured user data attached to every Crawlee request. */
export type ResearchRequestData = {
  projectId: string;
  researchRunId: string;
  topicId: string;
  subquestionId?: string;
  parentUrl?: string;
  sourceType?: string;
  discoveryQuery?: string;
  depth: number;
  priority: number;
  discoveredBy: DiscoveredBy;
};

export type SourceClassification =
  | "primary-source"
  | "peer-reviewed"
  | "government"
  | "academic"
  | "journalism"
  | "educational-reference"
  | "industry"
  | "expert-commentary"
  | "opinion"
  | "advocacy"
  | "user-generated"
  | "unknown";

export type EvidenceStrength = "strong" | "moderate" | "weak";

export type EvidenceType =
  | "data"
  | "quote"
  | "finding"
  | "definition"
  | "example"
  | "opinion"
  | "prediction"
  | "historical-record";

export type EvidenceRecord = {
  id: string;
  projectId: string;
  researchRunId: string;
  sourceId: string;
  topicId: string;
  subquestionId?: string;
  claim: string;
  evidenceText: string;
  sourceLocation?: string;
  pageNumber?: number;
  sourcePublishedAt?: Date;
  relevanceScore: number;
  evidenceStrength: EvidenceStrength;
  evidenceType: EvidenceType;
};

export type VerificationStatus =
  | "well-supported"
  | "mostly-supported"
  | "partially-supported"
  | "disputed"
  | "weakly-supported"
  | "unsupported"
  | "outdated"
  | "unable-to-verify";

export type CitationStyle = "apa" | "mla" | "chicago" | "web";

export type StatementKind =
  | "fact"
  | "opinion"
  | "inference"
  | "uncertain"
  | "direct-quotation"
  | "paraphrase"
  | "ai-synthesis"
  | "user-authored";

/** A source excerpt handed to an AI provider. Always data, never instructions. */
export type UntrustedSourceExcerpt = {
  sourceId: string;
  title: string;
  url: string;
  text: string;
  publishedAt?: string;
  instructionPolicy: "data-only";
};

export type ProviderId = "codex-cli" | "claude-code" | "gemini-cli" | "ollama" | "mock";

export const PROVIDER_IDS: ProviderId[] = [
  "codex-cli",
  "claude-code",
  "gemini-cli",
  "ollama",
  "mock",
];

export type ProviderStatusCode =
  | "not-installed"
  | "installed"
  | "authentication-required"
  | "authenticated"
  | "unsupported-plan"
  | "usage-limit-reached"
  | "temporarily-unavailable"
  | "misconfigured"
  | "ready";

export type ApiError = {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
};

export type CrawlLimits = {
  maxConcurrency: number;
  maxPagesPerRun: number;
  maxPagesPerDomain: number;
  maxDepth: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  defaultDelayMs: number;
  maxRetries: number;
  maxRedirects: number;
  maxTotalBytes: number;
  maxRunDurationMs: number;
};

/** Hard ceilings. User settings may lower limits but never exceed these. */
export const CRAWL_LIMIT_CEILINGS: CrawlLimits = {
  maxConcurrency: 10,
  maxPagesPerRun: 200,
  maxPagesPerDomain: 40,
  maxDepth: 4,
  requestTimeoutMs: 60_000,
  maxResponseBytes: 25_000_000,
  defaultDelayMs: 60_000,
  maxRetries: 5,
  maxRedirects: 8,
  maxTotalBytes: 250_000_000,
  maxRunDurationMs: 30 * 60_000,
};

export const DEFAULT_CRAWL_LIMITS: CrawlLimits = {
  maxConcurrency: 5,
  maxPagesPerRun: 50,
  maxPagesPerDomain: 10,
  maxDepth: 2,
  requestTimeoutMs: 30_000,
  maxResponseBytes: 10_000_000,
  defaultDelayMs: 1_000,
  maxRetries: 2,
  maxRedirects: 5,
  maxTotalBytes: 100_000_000,
  maxRunDurationMs: 15 * 60_000,
};

/** Clamp requested limits so no value exceeds the hard ceilings or drops below 0/1 floors. */
export function clampCrawlLimits(partial: Partial<CrawlLimits> | undefined): CrawlLimits {
  const merged = { ...DEFAULT_CRAWL_LIMITS, ...(partial ?? {}) };
  const clamp = (value: number, ceiling: number, floor = 1) =>
    Math.max(floor, Math.min(Math.floor(value), ceiling));
  return {
    maxConcurrency: clamp(merged.maxConcurrency, CRAWL_LIMIT_CEILINGS.maxConcurrency),
    maxPagesPerRun: clamp(merged.maxPagesPerRun, CRAWL_LIMIT_CEILINGS.maxPagesPerRun),
    maxPagesPerDomain: clamp(merged.maxPagesPerDomain, CRAWL_LIMIT_CEILINGS.maxPagesPerDomain),
    maxDepth: clamp(merged.maxDepth, CRAWL_LIMIT_CEILINGS.maxDepth, 0),
    requestTimeoutMs: clamp(merged.requestTimeoutMs, CRAWL_LIMIT_CEILINGS.requestTimeoutMs, 1000),
    maxResponseBytes: clamp(
      merged.maxResponseBytes,
      CRAWL_LIMIT_CEILINGS.maxResponseBytes,
      10_000
    ),
    defaultDelayMs: clamp(merged.defaultDelayMs, CRAWL_LIMIT_CEILINGS.defaultDelayMs, 0),
    maxRetries: clamp(merged.maxRetries, CRAWL_LIMIT_CEILINGS.maxRetries, 0),
    maxRedirects: clamp(merged.maxRedirects, CRAWL_LIMIT_CEILINGS.maxRedirects, 0),
    maxTotalBytes: clamp(merged.maxTotalBytes, CRAWL_LIMIT_CEILINGS.maxTotalBytes, 100_000),
    maxRunDurationMs: clamp(
      merged.maxRunDurationMs,
      CRAWL_LIMIT_CEILINGS.maxRunDurationMs,
      10_000
    ),
  };
}

export type ProgressEvent = {
  runId: string;
  stage: ResearchStage;
  at: string;
  message?: string;
  counters: {
    pagesDiscovered: number;
    pagesQueued: number;
    pagesCompleted: number;
    pagesSkipped: number;
    pagesFailed: number;
    sourcesAccepted: number;
    sourcesRejected: number;
    evidenceRecords: number;
    citations: number;
  };
  currentDomain?: string;
  currentProvider?: string;
  providerError?: string;
  done: boolean;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchHitType =
  | "report"
  | "evidence"
  | "source"
  | "claim"
  | "citation"
  | "project"
  | "note";

export const SEARCH_HIT_TYPES: SearchHitType[] = [
  "report",
  "evidence",
  "source",
  "claim",
  "citation",
  "project",
  "note",
];

/**
 * One cross-project search hit. `snippet` wraps matched terms in [[ ]]
 * delimiters (safe plain text — the client converts them to <mark>).
 */
export type SearchHit = {
  type: SearchHitType;
  entityId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  snippet: string;
  rank: number;
  date: string | null;
  /** Type-specific extras used to build deep links and badges. */
  extra: {
    reportId?: string;
    sourceId?: string;
    sourceUrl?: string;
    marker?: number;
    qualityScore?: number;
    classification?: string;
    verificationStatus?: string | null;
    sectionKind?: string;
  };
};

// ---------------------------------------------------------------------------
// Research-run preview
// ---------------------------------------------------------------------------

export type PreviewCandidate = {
  url: string;
  title: string;
  domain: string;
  discoveredBy: string;
  providerId: string;
  snippet?: string;
  publishedAt?: string;
  robots: "allowed" | "disallowed" | "unknown";
  flags: string[]; // e.g. "possible-duplicate", "user-generated-domain", "opinion-section", "blocked-by-rules"
  score: number;
  included: boolean;
};

export type RunPreview = {
  plan: {
    mainQuestion: string;
    subquestions: string[];
    keyTerms: string[];
    discoveryQueries: string[];
    sourceCategories: string[];
    outline: string[];
  };
  queries: { query: string; providerId: string; results: number }[];
  candidates: PreviewCandidate[];
  domains: { domain: string; count: number }[];
  workload: {
    candidateCount: number;
    includedCount: number;
    plannedPages: number;
    maxDepth: number;
    maxResearchTurns: number;
    processingStages: number;
    note: string;
  };
  warnings: string[];
};

export function emptyCounters(): ProgressEvent["counters"] {
  return {
    pagesDiscovered: 0,
    pagesQueued: 0,
    pagesCompleted: 0,
    pagesSkipped: 0,
    pagesFailed: 0,
    sourcesAccepted: 0,
    sourcesRejected: 0,
    evidenceRecords: 0,
    citations: 0,
  };
}
