import {
  clampCrawlLimits,
  type CrawlLimits,
  type PreviewCandidate,
  type ProviderId,
  type RunPreview,
} from "@omni/shared";
import { validateUrlSyntax, type UrlPolicy } from "@omni/security";
import { RobotsPolicy, domainOf, isVideoUrl, normalizeUrl, scoreCandidates } from "@omni/crawler";
import type { PrismaClient } from "@omni/database";
import type { ProviderManager } from "@omni/ai-providers";
import { PLAN_SCHEMA_DESCRIPTION, planOutputSchema, type PlanOutput } from "./schemas.js";
import { discoverCandidates } from "./discovery.js";

const LOW_QUALITY_DOMAINS = [
  "reddit.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "pinterest.com",
  "quora.com",
  "tiktok.com",
  "instagram.com",
];

const ROBOTS_PRECHECK_LIMIT = 30;

export type PreviewOverrides = {
  maxSources?: number;
  crawlLimits?: Partial<CrawlLimits>;
  excludeDomains?: string[];
  extraUrls?: string[];
  forceReplan?: boolean;
};

/**
 * In-memory plan cache. Generating a plan is a single ~55s LLM call, and the
 * preview dialog re-runs on every source tweak (add URL, exclude domain,
 * rebuild). Until the user approves a run — after which the run's stored plan
 * takes over — those repeat previews would each regenerate the plan. Caching
 * it per project keeps re-previews instant. The key includes the plan's inputs
 * (prompt, topics, mode, provider), so editing the project auto-invalidates it.
 */
const PLAN_CACHE_TTL_MS = 60 * 60 * 1000;
const planCache = new Map<string, { key: string; plan: PlanOutput; expiresAt: number }>();

/**
 * Build a research-run preview WITHOUT crawling any content pages: generate
 * (or reuse) the plan, run discovery, score candidates, pre-check robots.txt
 * for the top candidates, and estimate the workload in concrete units
 * (pages, depth, stages) — never a made-up time estimate.
 */
export async function buildRunPreview(
  prisma: PrismaClient,
  providers: ProviderManager,
  projectId: string,
  overrides: PreviewOverrides = {}
): Promise<RunPreview> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      owner: { select: { defaultProvider: true } },
      topics: { orderBy: { order: "asc" } },
    },
  });
  const providerId = (project.provider ?? project.owner.defaultProvider ?? providers.defaultId()) as ProviderId;
  const provider = providers.get(providerId);
  const warnings: string[] = [];

  const limits = clampCrawlLimits({
    ...((project.crawlLimits as Partial<CrawlLimits> | null) ?? {}),
    ...(overrides.crawlLimits ?? {}),
  });
  const excludeDomains = [
    ...(((project.excludeDomains as string[]) ?? []) as string[]),
    ...(overrides.excludeDomains ?? []),
  ];
  const policy: UrlPolicy = {
    allowDomains: (project.includeDomains as string[]) ?? [],
    blockDomains: excludeDomains,
  };
  const userAgent = process.env.CRAWLER_USER_AGENT || "OmniResearchBot/1.0";

  // Reuse the newest run's plan when one exists (keeps user edits); otherwise
  // generate a fresh plan with the project's provider.
  const latestRun = await prisma.researchRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: { planJson: true },
  });
  let plan: PlanOutput;
  const parsed = latestRun?.planJson ? planOutputSchema.safeParse(latestRun.planJson) : null;
  const cacheKey = JSON.stringify({
    prompt: project.prompt,
    topics: project.topics.map((t) => t.name),
    mode: project.mode,
    provider: providerId,
  });
  const cached = planCache.get(projectId);
  const cacheHit =
    !overrides.forceReplan && cached && cached.key === cacheKey && cached.expiresAt > Date.now();
  if (parsed?.success) {
    // A saved run's plan always wins — it preserves any user edits.
    plan = parsed.data;
  } else if (cacheHit) {
    plan = cached.plan;
  } else {
    plan = await provider.generateStructured(
      {
        requestId: `preview-plan-${projectId}-${Date.now()}`,
        taskKind: "research-plan",
        instructions: [
          `You are planning research. Mode: ${project.mode}.`,
          `User request: ${project.prompt}`,
          `Topics: ${project.topics.map((t) => t.name).join("; ")}.`,
          "Produce a main research question, focused subquestions, key terms, discovery queries, useful source categories, and a report outline.",
        ].join("\n"),
        context: { prompt: project.prompt, topics: project.topics.map((t) => t.name), mode: project.mode },
        schemaDescription: PLAN_SCHEMA_DESCRIPTION,
      },
      planOutputSchema
    );
    planCache.set(projectId, { key: cacheKey, plan, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
  }

  const startingUrls = [
    ...(((project.startingUrls as string[]) ?? []) as string[]),
    ...(overrides.extraUrls ?? []),
  ];
  const discovery = await discoverCandidates({
    startingUrls,
    plan,
    policy,
    userAgent,
    dateRangeStart: project.dateRangeStart,
    dateRangeEnd: project.dateRangeEnd,
  });
  warnings.push(...discovery.notes.filter((n) => n.includes("failed")));

  const maxSources = Math.min(overrides.maxSources ?? project.maxSources ?? 20, limits.maxPagesPerRun);
  const queryText = `${plan.mainQuestion} ${plan.keyTerms.join(" ")}`;

  // Duplicate detection across the raw candidate list (before scoring trims it).
  const seenNormalized = new Map<string, number>();
  for (const candidate of discovery.candidates) {
    const normalized = normalizeUrl(candidate.url);
    if (normalized) seenNormalized.set(normalized, (seenNormalized.get(normalized) ?? 0) + 1);
  }

  const scored = scoreCandidates(discovery.candidates, {
    query: queryText,
    maxCandidates: Math.min(maxSources * 2, 60),
    maxPerDomain: limits.maxPagesPerDomain,
  });

  const robots = new RobotsPolicy(userAgent);
  const candidates: PreviewCandidate[] = [];
  for (const [index, candidate] of scored.entries()) {
    const normalized = normalizeUrl(candidate.url) ?? candidate.url;
    const domain = domainOf(normalized);
    const flags: string[] = [];

    const video = isVideoUrl(normalized);
    const syntax = validateUrlSyntax(normalized, policy);
    if (video) {
      // Transcribed during the run (captions), not HTML-crawled.
      flags.push("video-transcript-source");
    } else if (!syntax.ok) {
      flags.push(`blocked-by-rules: ${syntax.reason}`);
    }
    if ((seenNormalized.get(normalized) ?? 0) > 1) flags.push("possible-duplicate");
    if (!video && LOW_QUALITY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      flags.push("user-generated-domain");
    }
    if (!video && /\/(opinion|editorial|op-ed|blog)s?\//i.test(normalized)) flags.push("opinion-section");

    // Robots pre-check for the strongest candidates only (bounded for speed).
    // Video URLs are transcribed via yt-dlp captions, not HTML-crawled, so the
    // HTML robots rules do not gate them.
    let robotsVerdict: PreviewCandidate["robots"] = video ? "allowed" : "unknown";
    if (!video && syntax.ok && index < ROBOTS_PRECHECK_LIMIT) {
      try {
        const check = await robots.check(normalized);
        robotsVerdict = check.allowed ? "allowed" : "disallowed";
      } catch {
        robotsVerdict = "unknown";
      }
    }

    candidates.push({
      url: normalized,
      title: candidate.title,
      domain,
      discoveredBy: candidate.discoveredBy,
      providerId: candidate.providerId ?? candidate.discoveredBy,
      snippet: candidate.snippet,
      publishedAt: candidate.publishedAt?.toISOString(),
      robots: robotsVerdict,
      flags,
      score: Math.max(0, scored.length - index),
      included:
        (video || (syntax.ok && robotsVerdict !== "disallowed")) &&
        !flags.includes("possible-duplicate") &&
        candidates.filter((c) => c.included).length < maxSources,
    });
  }

  if (candidates.length === 0) {
    warnings.push(
      "No crawlable sources were discovered. Add starting URLs, RSS feeds, sitemaps, or configure a web-search provider key."
    );
  }

  const domainCounts = new Map<string, number>();
  for (const candidate of candidates) {
    domainCounts.set(candidate.domain, (domainCounts.get(candidate.domain) ?? 0) + 1);
  }

  const includedCount = candidates.filter((c) => c.included).length;
  const maxTurns = Math.max(0, Math.min(4, Number(process.env.AI_MAX_RESEARCH_TURNS ?? 2)));
  return {
    plan,
    queries: discovery.queries,
    candidates,
    domains: [...domainCounts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count),
    workload: {
      candidateCount: candidates.length,
      includedCount,
      plannedPages: Math.min(includedCount, maxSources),
      maxDepth: limits.maxDepth,
      maxResearchTurns: maxTurns,
      processingStages: 12,
      note:
        `Workload: up to ${Math.min(includedCount, maxSources)} pages crawled at depth ≤ ${limits.maxDepth}, ` +
        `then evidence extraction, up to ${maxTurns} follow-up research turn(s), disagreement reconciliation, ` +
        "synthesis, and citation verification. Duration depends on site response times and the AI provider — no time estimate is shown because it would be a guess.",
    },
    warnings,
  };
}
