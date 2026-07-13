import path from "node:path";
import {
  clampCrawlLimits,
  newId,
  type CrawlLimits,
  type ProgressEvent,
  type ProviderId,
  type ResearchStage,
  type UntrustedSourceExcerpt,
} from "@omni/shared";
import { fenceExcerpts, detectInjectionAttempt, type UrlPolicy } from "@omni/security";
import {
  classifySource,
  crawlPages,
  groupDuplicates,
  normalizeUrl,
  scoreCandidates,
  type CrawlTask,
  type RetrievedPage,
  type SearchResult,
} from "@omni/crawler";
import type { PrismaClient } from "@omni/database";
import { ProviderError, type ProviderManager, type SubscriptionAIProvider } from "@omni/ai-providers";
import {
  EVIDENCE_SCHEMA_DESCRIPTION,
  GAP_ANALYSIS_SCHEMA_DESCRIPTION,
  PLAN_SCHEMA_DESCRIPTION,
  RECONCILIATION_SCHEMA_DESCRIPTION,
  evidenceOutputSchema,
  gapAnalysisOutputSchema,
  planOutputSchema,
  reconciliationOutputSchema,
  type PlanOutput,
} from "./schemas.js";
import { containsVerbatim, locateExcerpt, splitSentences } from "./text-utils.js";
import { synthesizeAndVerify, type DisagreementForReport } from "./report-builder.js";
import { discoverCandidates } from "./discovery.js";
import { detectConflicts, findEvidenceGaps, type ConflictInput } from "./reconcile.js";

export type Counters = ProgressEvent["counters"];

export type PipelineDeps = {
  prisma: PrismaClient;
  providers: ProviderManager;
  /** Persist + broadcast real progress. Called only for real state changes. */
  emit: (stage: ResearchStage, message: string, counters: Counters, extra?: Record<string, unknown>) => Promise<void>;
  isCancelled: () => Promise<boolean>;
  storageRoot?: string;
};

export class RunCancelledError extends Error {
  constructor() {
    super("Research run cancelled by user");
    this.name = "RunCancelledError";
  }
}

const emptyCounters = (): Counters => ({
  pagesDiscovered: 0,
  pagesQueued: 0,
  pagesCompleted: 0,
  pagesSkipped: 0,
  pagesFailed: 0,
  sourcesAccepted: 0,
  sourcesRejected: 0,
  evidenceRecords: 0,
  citations: 0,
});

type EvidenceRow = {
  id: string;
  sourceId: string;
  claim: string;
  evidenceText: string;
  subquestionId?: string;
  topicId?: string;
  relevanceScore: number;
  evidenceStrength: string;
  evidenceType: string;
  sourceTitle: string;
  sourcePublishedAt?: Date | null;
  sourceQuality?: number;
  sourceClassification?: string;
  pageNumber?: number;
  sourceLocation?: string;
  flaggedInjection: boolean;
};

type RunSettings = {
  approvedUrls?: string[];
  excludedUrls?: string[];
  excludeDomains?: string[];
  maxResearchTurns?: number;
  maxSources?: number;
  highQualityOnly?: boolean;
  excludeOpinion?: boolean;
  mockSearchResults?: SearchResult[];
};

/**
 * The full research pipeline for one ResearchRun. Every stage reads/writes
 * the database so progress is real, work is preserved across failures, and
 * runs can be inspected afterwards.
 *
 * Flow: understand → plan → discover → score → crawl waves → dedupe →
 * classify → extract evidence → [bounded reasoning loop: identify gaps →
 * follow-up discovery → crawl → extract] → reconcile disagreements →
 * synthesize → verify every citation.
 */
export async function runResearchPipeline(deps: PipelineDeps, runId: string): Promise<void> {
  const { prisma, providers } = deps;
  const counters = emptyCounters();

  const run = await prisma.researchRun.findUniqueOrThrow({
    where: { id: runId },
    include: { project: { include: { topics: { orderBy: { order: "asc" } } } } },
  });
  const project = run.project;
  const settings = ((run.limitsJson as RunSettings | null) ?? {}) as RunSettings;

  const checkCancelled = async () => {
    if (await deps.isCancelled()) throw new RunCancelledError();
  };

  const providerId = (project.provider ?? providers.defaultId()) as ProviderId;
  const provider: SubscriptionAIProvider = providers.get(providerId);

  const limits: CrawlLimits = clampCrawlLimits({
    ...((project.crawlLimits as Partial<CrawlLimits> | null) ?? {}),
    ...((run.limitsJson as Partial<CrawlLimits> | null) ?? {}),
  });

  const policy: UrlPolicy = {
    allowDomains: (project.includeDomains as string[]) ?? [],
    blockDomains: [
      ...(((project.excludeDomains as string[]) ?? []) as string[]),
      ...(settings.excludeDomains ?? []),
    ],
  };
  const userAgent = process.env.CRAWLER_USER_AGENT || "OmniResearchBot/1.0";
  const excludedNormalized = new Set(
    (settings.excludedUrls ?? []).map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u))
  );

  // Ensure at least one topic exists.
  let topics = project.topics;
  if (topics.length === 0) {
    const topic = await prisma.topic.create({
      data: { id: newId("top"), projectId: project.id, name: project.title.slice(0, 190), order: 0 },
    });
    topics = [topic];
  }

  // ---- Stage 1–2: understand + plan ---------------------------------------
  await deps.emit("understanding-request", `Interpreting the request with ${provider.displayName}`, counters, {
    provider: providerId,
  });
  await checkCancelled();

  let plan: PlanOutput;
  const existingPlan = run.planJson as PlanOutput | null;
  const planParse = existingPlan ? planOutputSchema.safeParse(existingPlan) : null;
  if (planParse?.success) {
    plan = planParse.data; // user-approved plan (plan page or run preview)
    await deps.emit("building-plan", "Using the user-approved research plan", counters);
  } else {
    await deps.emit("building-plan", "Generating research plan", counters);
    plan = await provider.generateStructured(
      {
        requestId: `plan-${runId}`,
        taskKind: "research-plan",
        instructions: [
          `You are planning research. Mode: ${project.mode}.`,
          `User request: ${project.prompt}`,
          project.gradeLevel ? `Audience/grade level: ${project.gradeLevel}.` : "",
          `Topics: ${topics.map((t) => t.name).join("; ")}.`,
          "Produce a main research question, focused subquestions (2-4 per topic), key terms, discovery queries, useful source categories, and a report outline.",
        ]
          .filter(Boolean)
          .join("\n"),
        context: { prompt: project.prompt, topics: topics.map((t) => t.name), mode: project.mode },
        schemaDescription: PLAN_SCHEMA_DESCRIPTION,
      },
      planOutputSchema
    );
    await prisma.researchRun.update({ where: { id: runId }, data: { planJson: plan as object } });
  }

  await deps.emit("generating-subquestions", `Recording ${plan.subquestions.length} subquestions`, counters);
  const subquestionRows: { id: string; text: string; topicId: string | null }[] = [];
  const existingSubquestions = await prisma.subquestion.findMany({ where: { runId }, orderBy: { order: "asc" } });
  if (existingSubquestions.length > 0) {
    subquestionRows.push(...existingSubquestions);
  } else {
    for (const [index, text] of plan.subquestions.entries()) {
      const topic = topics[Math.min(Math.floor(index / Math.max(1, Math.ceil(plan.subquestions.length / topics.length))), topics.length - 1)]!;
      subquestionRows.push(
        await prisma.subquestion.create({
          data: { id: newId("sq"), runId, topicId: topic.id, text: text.slice(0, 490), order: index },
        })
      );
    }
  }

  // ---- Stage 3: discover candidates ---------------------------------------
  await deps.emit("discovering-sources", "Discovering candidate sources", counters);
  await checkCancelled();

  const discoveryNotes: string[] = [];
  let candidates: SearchResult[] = [];

  if (settings.approvedUrls?.length) {
    // The user approved an explicit URL list in the run preview: crawl exactly
    // those (still subject to every safety policy), skip re-discovery.
    candidates = settings.approvedUrls
      .map((url) => normalizeUrl(url))
      .filter((url): url is string => Boolean(url))
      .map((url) => ({ url, title: url, discoveredBy: "user" as const, providerId: "preview-approved" }));
    discoveryNotes.push(`${candidates.length} URL(s) approved in the run preview`);
  } else {
    const discovery = await discoverCandidates({
      startingUrls: ((project.startingUrls as string[]) ?? []).filter(Boolean),
      plan,
      policy,
      userAgent,
      dateRangeStart: project.dateRangeStart,
      dateRangeEnd: project.dateRangeEnd,
      mockSearchResults: settings.mockSearchResults,
    });
    candidates = discovery.candidates;
    discoveryNotes.push(...discovery.notes);
    for (const record of discovery.queries) {
      await prisma.discoveryQuery.create({
        data: { id: newId("dq"), runId, query: record.query.slice(0, 490), providerId: record.providerId, results: record.results },
      });
    }
  }

  candidates = candidates.filter((c) => {
    const normalized = normalizeUrl(c.url);
    return normalized && !excludedNormalized.has(normalized);
  });

  counters.pagesDiscovered = candidates.length;
  await deps.emit("scoring-candidates", `Scoring ${candidates.length} candidate(s) before crawling`, counters);

  const maxSources = Math.min(settings.maxSources ?? project.maxSources ?? 20, limits.maxPagesPerRun);
  const queryText = `${plan.mainQuestion} ${plan.keyTerms.join(" ")}`;
  let wave = scoreCandidates(candidates, {
    query: queryText,
    maxCandidates: maxSources,
    maxPerDomain: limits.maxPagesPerDomain,
  });

  if (wave.length === 0) {
    throw new Error(
      "No crawlable sources were discovered. Add starting URLs, RSS feeds, or sitemaps to this project (or configure an optional web-search provider key) — OmniResearch cannot search the whole internet without configured discovery sources."
    );
  }

  // ---- Reusable wave helpers (also used by the reasoning loop) --------------
  const acceptedPages: RetrievedPage[] = [];
  const seenNormalized = new Set<string>();
  const sourceIdByPage = new Map<RetrievedPage, string>();
  const evidenceRows: EvidenceRow[] = [];
  let evidenceBatchCounter = 0;

  const crawlWave = async (
    waveCandidates: SearchResult[],
    depth: number
  ): Promise<{ retrieved: RetrievedPage[]; linkCandidates: SearchResult[] }> => {
    const tasks: CrawlTask[] = waveCandidates.map((candidate, index) => ({
      url: candidate.url,
      userData: {
        projectId: project.id,
        researchRunId: runId,
        topicId: topics[0]!.id,
        depth,
        priority: waveCandidates.length - index,
        discoveredBy: candidate.discoveredBy,
      },
    }));

    for (const task of tasks) {
      const normalized = normalizeUrl(task.url);
      if (!normalized) continue;
      await prisma.crawlRequest.upsert({
        where: { runId_normalizedUrl: { runId, normalizedUrl: normalized } },
        create: {
          id: newId("cr"),
          runId,
          url: task.url,
          normalizedUrl: normalized,
          depth,
          priority: task.userData.priority,
          discoveredBy: task.userData.discoveredBy,
          status: "queued",
        },
        update: {},
      });
    }
    counters.pagesQueued += tasks.length;
    await deps.emit("queuing-pages", `Queued ${tasks.length} page(s) at depth ${depth}`, counters);
    await deps.emit("crawling", `Crawling depth ${depth}`, counters);

    const outcome = await crawlPages({
      tasks,
      limits: {
        ...limits,
        maxPagesPerRun: Math.max(1, Math.min(limits.maxPagesPerRun - counters.pagesCompleted, maxSources - acceptedPages.length + 5)),
      },
      policy,
      userAgent,
      storageDir: path.join(deps.storageRoot ?? ".local-data", "crawlee", runId),
      runId,
      shouldCancel: () => false, // cooperative cancel handled between stages
      onEvent: (event) => {
        if (event.kind === "retrieved") counters.pagesCompleted++;
        if (event.kind === "skipped") counters.pagesSkipped++;
        if (event.kind === "failed") counters.pagesFailed++;
      },
    });

    for (const page of outcome.retrieved) {
      const normalized = normalizeUrl(page.finalUrl) ?? normalizeUrl(page.requestedUrl);
      if (normalized) {
        await prisma.crawlRequest.updateMany({
          where: { runId, normalizedUrl: normalizeUrl(page.requestedUrl) ?? normalized },
          data: { status: "retrieved" },
        });
      }
    }
    for (const skip of outcome.skipped) {
      await prisma.crawlRequest.updateMany({
        where: { runId, normalizedUrl: normalizeUrl(skip.url) ?? skip.url },
        data: { status: "skipped", skipReason: `${skip.reason}: ${skip.detail}`.slice(0, 490) },
      });
    }
    for (const failure of outcome.failed) {
      await prisma.crawlRequest.updateMany({
        where: { runId, normalizedUrl: normalizeUrl(failure.url) ?? failure.url },
        data: { status: "failed", failureReason: failure.error.slice(0, 490), retryCount: failure.retries },
      });
    }
    await deps.emit(
      "extracting-content",
      `Depth ${depth}: retrieved ${outcome.retrieved.length}, skipped ${outcome.skipped.length}, failed ${outcome.failed.length}`,
      counters
    );

    const fresh: RetrievedPage[] = [];
    for (const page of outcome.retrieved) {
      const normalized = normalizeUrl(page.finalUrl) ?? page.finalUrl;
      if (!seenNormalized.has(normalized) && acceptedPages.length < maxSources) {
        seenNormalized.add(normalized);
        acceptedPages.push(page);
        fresh.push(page);
      }
    }

    const linkCandidates: SearchResult[] = outcome.retrieved.flatMap((page) =>
      page.outboundLinks.slice(0, 40).map((link) => ({
        url: link.url,
        title: link.text || link.url,
        snippet: link.text,
        discoveredBy: "page-link" as const,
        providerId: "page-links",
      }))
    );
    counters.pagesDiscovered += linkCandidates.length;
    return { retrieved: fresh, linkCandidates };
  };

  const persistSources = async (pages: RetrievedPage[]): Promise<RetrievedPage[]> => {
    await deps.emit("deduplicating", `Deduplicating ${pages.length} retrieved page(s)`, counters);
    const groups = groupDuplicates(pages);
    await deps.emit("classifying-sources", "Classifying and scoring sources", counters);
    const storeFullText = project.storeFullText || (process.env.STORE_FULL_SOURCE_CONTENT ?? "").toLowerCase() === "true";
    const retentionDays = project.retentionDays || Number(process.env.SOURCE_CONTENT_RETENTION_DAYS || 30);
    const retentionUntil = new Date(Date.now() + retentionDays * 86_400_000);
    const kept: RetrievedPage[] = [];

    for (const group of groups) {
      const page = group.primary;
      const classified = classifySource(page);

      // Preview filters: enforce server-side, and record WHY a page was dropped.
      if (settings.highQualityOnly && classified.qualityScore < 55) {
        counters.sourcesRejected++;
        await prisma.runEvent.create({
          data: {
            id: newId("ev"),
            runId,
            stage: "classifying-sources",
            message: `Dropped ${page.finalUrl}: quality ${classified.qualityScore} below the high-quality-only threshold (55).`,
          },
        });
        continue;
      }
      if (settings.excludeOpinion && (classified.classification === "opinion" || page.metadata.isOpinionSection)) {
        counters.sourcesRejected++;
        await prisma.runEvent.create({
          data: {
            id: newId("ev"),
            runId,
            stage: "classifying-sources",
            message: `Dropped ${page.finalUrl}: classified as opinion and the run excludes opinion pieces.`,
          },
        });
        continue;
      }

      const normalized = normalizeUrl(page.finalUrl) ?? page.finalUrl;
      const injection = detectInjectionAttempt(page.mainText.slice(0, 20_000));
      const source = await prisma.source.upsert({
        where: { projectId_normalizedUrl: { projectId: project.id, normalizedUrl: normalized } },
        create: {
          id: newId("src"),
          projectId: project.id,
          url: page.requestedUrl,
          finalUrl: page.finalUrl,
          canonicalUrl: page.canonicalUrl,
          normalizedUrl: normalized,
          title: page.metadata.title?.slice(0, 490),
          author: page.metadata.author?.slice(0, 290),
          publisher: page.metadata.publisher?.slice(0, 290),
          siteName: page.metadata.siteName?.slice(0, 290),
          language: page.metadata.language?.slice(0, 30),
          contentType: page.contentType,
          crawlMethod: page.crawlMethod,
          status: "retrieved",
          publishedAt: page.metadata.publishedAt,
          modifiedAt: page.metadata.modifiedAt,
          retrievedAt: page.retrievedAt,
          wordCount: page.wordCount,
          pageCount: page.pageCount,
          contentHash: page.contentHash,
          classification: classified.classification,
          qualityScore: classified.qualityScore,
          scoreReasons: classified.reasons,
          isOpinion: Boolean(page.metadata.isOpinionSection),
          paywallFlag: page.paywallSuspected,
          headings: page.headings.slice(0, 40),
          excerpt: page.mainText.slice(0, 1500),
          discoveredBy: page.userData.discoveredBy,
          retentionUntil,
        },
        update: {
          retrievedAt: page.retrievedAt,
          wordCount: page.wordCount,
          contentHash: page.contentHash,
          qualityScore: classified.qualityScore,
          scoreReasons: classified.reasons,
          status: "retrieved",
        },
      });
      sourceIdByPage.set(page, source.id);
      counters.sourcesAccepted++;
      kept.push(page);

      if (injection.flagged) {
        await prisma.runEvent.create({
          data: {
            id: newId("ev"),
            runId,
            stage: "classifying-sources",
            message: `Source ${source.id} contains instruction-like text (possible prompt injection). It is treated strictly as data.`,
            dataJson: { matches: injection.matches.slice(0, 5) },
          },
        });
      }

      // Always store the main text snapshot for citation verification; retention
      // cleanup later trims it per the project's policy.
      await prisma.sourceSnapshot.deleteMany({ where: { sourceId: source.id, kind: "main-text" } });
      await prisma.sourceSnapshot.create({
        data: {
          id: newId("snap"),
          sourceId: source.id,
          kind: "main-text",
          contentText: storeFullText ? page.mainText : page.mainText.slice(0, 60_000),
          pageTexts: page.pageTexts ? page.pageTexts.slice(0, 200) : undefined,
          bytes: Buffer.byteLength(page.mainText),
        },
      });

      for (const dup of group.duplicates) {
        counters.sourcesRejected++;
        const dupNormalized = normalizeUrl(dup.page.finalUrl) ?? dup.page.finalUrl;
        if (dupNormalized === normalized) continue;
        await prisma.source.upsert({
          where: { projectId_normalizedUrl: { projectId: project.id, normalizedUrl: dupNormalized } },
          create: {
            id: newId("src"),
            projectId: project.id,
            url: dup.page.requestedUrl,
            finalUrl: dup.page.finalUrl,
            normalizedUrl: dupNormalized,
            title: dup.page.metadata.title?.slice(0, 490),
            status: "retrieved",
            duplicateOfId: source.id,
            contentHash: dup.page.contentHash,
            retrievedAt: dup.page.retrievedAt,
            discoveredBy: dup.page.userData.discoveredBy,
          },
          update: { duplicateOfId: source.id },
        });
      }
    }
    await deps.emit("classifying-sources", `Accepted ${counters.sourcesAccepted} source(s), grouped ${counters.sourcesRejected} duplicate/filtered page(s)`, counters);
    return kept;
  };

  const extractEvidence = async (pages: RetrievedPage[]): Promise<void> => {
    const usable = pages.filter((p) => sourceIdByPage.has(p));
    const BATCH = 4;
    for (let i = 0; i < usable.length; i += BATCH) {
      await checkCancelled();
      const batch = usable.slice(i, i + BATCH);
      const excerpts: UntrustedSourceExcerpt[] = [];
      const contextSources: { sourceId: string; title: string; url: string; sentences: string[] }[] = [];
      for (const page of batch) {
        const sourceId = sourceIdByPage.get(page)!;
        const sentences = splitSentences(page.mainText, { maxSentences: 60 });
        contextSources.push({
          sourceId,
          title: page.metadata.title ?? page.finalUrl,
          url: page.finalUrl,
          sentences,
        });
        excerpts.push({
          sourceId,
          title: page.metadata.title ?? page.finalUrl,
          url: page.finalUrl,
          text: sentences.join("\n"),
          publishedAt: page.metadata.publishedAt?.toISOString(),
          instructionPolicy: "data-only",
        });
      }
      const fenced = fenceExcerpts(excerpts, runId);

      let extraction;
      try {
        extraction = await provider.generateStructured(
          {
            requestId: `evidence-${runId}-${evidenceBatchCounter++}`,
            taskKind: "evidence-extraction",
            instructions: [
              `Extract evidence relevant to this research question: ${plan.mainQuestion}`,
              `Subquestions (cite by index):\n${plan.subquestions.map((s, idx) => `${idx}. ${s}`).join("\n")}`,
              "For each relevant EXACT sentence in the source material, produce one evidence record.",
              "evidenceText must be copied verbatim — records whose text is not found in the source are discarded.",
              "Classify opinion and prediction sentences accordingly; do not present them as fact.",
            ].join("\n"),
            data: fenced.text,
            context: { query: queryText, subquestions: plan.subquestions, sources: contextSources },
            schemaDescription: EVIDENCE_SCHEMA_DESCRIPTION,
          },
          evidenceOutputSchema
        );
      } catch (err) {
        if (err instanceof ProviderError) {
          throw new Error(
            `AI provider "${providerId}" failed during evidence extraction (${err.code}): ${err.message}. ` +
              `All crawled sources were saved; you can switch providers and regenerate without re-crawling.`
          );
        }
        throw err;
      }

      for (const item of extraction.evidence) {
        const contextSource = contextSources.find((s) => s.sourceId === item.sourceId);
        const page = batch.find((p) => sourceIdByPage.get(p) === item.sourceId);
        if (!contextSource || !page) continue; // provider hallucinated a sourceId — discard
        // NEVER store fabricated evidence: the excerpt must exist verbatim.
        if (!containsVerbatim(page.mainText, item.evidenceText)) {
          await prisma.runEvent.create({
            data: {
              id: newId("ev"),
              runId,
              stage: "extracting-evidence",
              message: `Discarded evidence for source ${item.sourceId}: excerpt not found verbatim in retrieved content.`,
            },
          });
          continue;
        }
        const injection = detectInjectionAttempt(item.evidenceText);
        const subquestion =
          item.subquestionIndex !== undefined ? subquestionRows[item.subquestionIndex] : undefined;
        let pageNumber: number | undefined;
        if (page.pageTexts) {
          const pageIndex = page.pageTexts.findIndex((t) => containsVerbatim(t, item.evidenceText));
          if (pageIndex >= 0) pageNumber = pageIndex + 1;
        }
        const classified = classifySource(page);
        evidenceRows.push({
          id: newId("evd"),
          sourceId: item.sourceId,
          claim: item.claim,
          evidenceText: item.evidenceText,
          subquestionId: subquestion?.id,
          topicId: subquestion?.topicId ?? topics[0]!.id,
          relevanceScore: item.relevanceScore,
          evidenceStrength: item.evidenceStrength,
          evidenceType: item.evidenceType,
          sourceTitle: contextSource.title,
          sourcePublishedAt: page.metadata.publishedAt ?? null,
          sourceQuality: classified.qualityScore,
          sourceClassification: classified.classification,
          pageNumber,
          sourceLocation: pageNumber ? `page ${pageNumber}` : locateExcerpt(page.mainText, item.evidenceText),
          flaggedInjection: injection.flagged,
        });
      }
    }
  };

  // ---- Stage 4–5: initial crawl waves ---------------------------------------
  let depth = 0;
  const freshPages: RetrievedPage[] = [];
  while (wave.length > 0 && depth <= limits.maxDepth && acceptedPages.length < maxSources) {
    await checkCancelled();
    const { retrieved, linkCandidates } = await crawlWave(wave, depth);
    freshPages.push(...retrieved);
    depth++;
    if (depth > limits.maxDepth || acceptedPages.length >= maxSources) break;
    wave = scoreCandidates(
      linkCandidates.filter((c) => {
        const n = normalizeUrl(c.url);
        return n && !seenNormalized.has(n) && !excludedNormalized.has(n);
      }),
      { query: queryText, maxCandidates: Math.min(10, maxSources - acceptedPages.length), maxPerDomain: 3 }
    );
  }

  if (await deps.isCancelled()) throw new RunCancelledError();

  // ---- Stage 5–7: dedupe + classify + evidence -------------------------------
  const keptPages = await persistSources(freshPages);

  await checkCancelled();
  await deps.emit("extracting-evidence", `Extracting evidence with ${provider.displayName}`, counters, { provider: providerId });
  await extractEvidence(keptPages);

  // ---- Multi-turn reasoning loop: gaps → follow-up discovery → crawl → extract
  const maxTurns = Math.max(
    0,
    Math.min(4, settings.maxResearchTurns ?? Number(process.env.AI_MAX_RESEARCH_TURNS ?? 2))
  );
  const attemptedFollowupQueries = new Set<string>();

  for (let turn = 1; turn <= maxTurns; turn++) {
    await checkCancelled();
    if (acceptedPages.length >= maxSources) {
      await deps.emit("identifying-gaps", `Source limit (${maxSources}) reached — skipping follow-up turns`, counters);
      break;
    }

    const gaps = findEvidenceGaps(subquestionRows, evidenceRows);
    await deps.emit(
      "identifying-gaps",
      gaps.length === 0
        ? "Evidence coverage check: every subquestion has supporting evidence"
        : `Evidence coverage check (turn ${turn}/${maxTurns}): ${gaps.length} subquestion(s) under-supported`,
      counters
    );
    if (gaps.length === 0) break;

    let gapAnalysis;
    try {
      gapAnalysis = await provider.generateStructured(
        {
          requestId: `gaps-${runId}-${turn}`,
          taskKind: "gap-analysis",
          instructions: [
            `Research question: ${plan.mainQuestion}`,
            "Some subquestions lack evidence. Propose specific follow-up search queries that could fill the gaps.",
            "Set coverageSufficient=true only if further searching is unlikely to help.",
            "decisionNote must be ONE concise sentence explaining the decision — no hidden reasoning.",
          ].join("\n"),
          context: {
            subquestions: subquestionRows.map((s) => s.text),
            evidenceCounts: subquestionRows.map((s) => evidenceRows.filter((e) => e.subquestionId === s.id).length),
            previousQueries: [...attemptedFollowupQueries],
          },
          schemaDescription: GAP_ANALYSIS_SCHEMA_DESCRIPTION,
        },
        gapAnalysisOutputSchema
      );
    } catch (err) {
      await prisma.runEvent.create({
        data: {
          id: newId("ev"),
          runId,
          stage: "identifying-gaps",
          message: `Gap analysis failed (${(err as Error).message.slice(0, 200)}); continuing with the evidence already collected.`,
        },
      });
      break;
    }

    await prisma.runEvent.create({
      data: {
        id: newId("ev"),
        runId,
        stage: "identifying-gaps",
        message: `Decision: ${gapAnalysis.decisionNote || "(no note)"}`,
        dataJson: { gaps: gapAnalysis.gaps, followupQueries: gapAnalysis.followupQueries },
      },
    });
    if (gapAnalysis.coverageSufficient || gapAnalysis.followupQueries.length === 0) break;

    const newQueries = gapAnalysis.followupQueries.filter((q) => !attemptedFollowupQueries.has(q.toLowerCase()));
    newQueries.forEach((q) => attemptedFollowupQueries.add(q.toLowerCase()));
    if (newQueries.length === 0) break;

    await deps.emit("following-up", `Turn ${turn}: searching for ${newQueries.length} follow-up quer(ies)`, counters);
    const followupDiscovery = await discoverCandidates({
      startingUrls: [],
      plan,
      policy,
      userAgent,
      dateRangeStart: project.dateRangeStart,
      dateRangeEnd: project.dateRangeEnd,
      mockSearchResults: settings.mockSearchResults,
      queriesOverride: newQueries,
    });
    for (const record of followupDiscovery.queries) {
      await prisma.discoveryQuery.create({
        data: { id: newId("dq"), runId, query: record.query.slice(0, 490), providerId: record.providerId, results: record.results },
      });
    }
    const followupWave = scoreCandidates(
      followupDiscovery.candidates.filter((c) => {
        const n = normalizeUrl(c.url);
        return n && !seenNormalized.has(n) && !excludedNormalized.has(n);
      }),
      { query: queryText, maxCandidates: Math.min(8, maxSources - acceptedPages.length), maxPerDomain: 3 }
    );
    if (followupWave.length === 0) {
      await deps.emit("following-up", `Turn ${turn}: no new sources found for the gap queries`, counters);
      break;
    }

    const { retrieved } = await crawlWave(followupWave, 0);
    if (retrieved.length === 0) {
      await deps.emit("following-up", `Turn ${turn}: follow-up crawl retrieved no usable pages`, counters);
      break;
    }
    const keptFollowup = await persistSources(retrieved);
    const before = evidenceRows.length;
    await extractEvidence(keptFollowup);
    await deps.emit(
      "following-up",
      `Turn ${turn}: added ${keptFollowup.length} source(s) and ${evidenceRows.length - before} evidence record(s)`,
      counters
    );
  }

  // ---- Persist evidence ------------------------------------------------------
  for (const row of evidenceRows) {
    await prisma.evidence.create({
      data: {
        id: row.id,
        projectId: project.id,
        runId,
        sourceId: row.sourceId,
        topicId: row.topicId,
        subquestionId: row.subquestionId,
        claim: row.claim,
        evidenceText: row.evidenceText,
        sourceLocation: row.sourceLocation,
        pageNumber: row.pageNumber,
        sourcePublishedAt: row.sourcePublishedAt,
        relevanceScore: row.relevanceScore,
        evidenceStrength: row.evidenceStrength,
        evidenceType: row.evidenceType,
        flaggedInjection: row.flaggedInjection,
      },
    });
    counters.evidenceRecords++;
  }
  await deps.emit("comparing-claims", `Stored ${counters.evidenceRecords} evidence record(s)`, counters);

  if (evidenceRows.length === 0) {
    throw new Error(
      "No verifiable evidence could be extracted from the crawled sources. The sources were saved to the library. " +
        "Try adding more substantial sources or increasing the source limit — OmniResearch will not write a report without stored evidence."
    );
  }

  // ---- Disagreement detection + reconciliation --------------------------------
  const disagreements: DisagreementForReport[] = [];
  const conflictInputs: ConflictInput[] = evidenceRows.map((row) => ({
    id: row.id,
    sourceId: row.sourceId,
    claim: row.claim,
    evidenceText: row.evidenceText,
    subquestionId: row.subquestionId,
    sourceTitle: row.sourceTitle,
    sourcePublishedAt: row.sourcePublishedAt,
    sourceQuality: row.sourceQuality,
    sourceClassification: row.sourceClassification,
  }));
  const conflicts = detectConflicts(conflictInputs);

  if (conflicts.length > 0) {
    await deps.emit(
      "reconciling-disagreements",
      `Found ${conflicts.length} potential disagreement(s) between sources — reconciling with ${provider.displayName}`,
      counters
    );
    try {
      const fenced = fenceExcerpts(
        conflicts.flatMap((pair, index) => [
          {
            sourceId: `pair-${index}-a`,
            title: pair.a.sourceTitle,
            url: "",
            text: `CLAIM: ${pair.a.claim}\nEXCERPT: ${pair.a.evidenceText}`,
            publishedAt: pair.a.sourcePublishedAt?.toISOString(),
            instructionPolicy: "data-only" as const,
          },
          {
            sourceId: `pair-${index}-b`,
            title: pair.b.sourceTitle,
            url: "",
            text: `CLAIM: ${pair.b.claim}\nEXCERPT: ${pair.b.evidenceText}`,
            publishedAt: pair.b.sourcePublishedAt?.toISOString(),
            instructionPolicy: "data-only" as const,
          },
        ]),
        runId
      );
      const reconciliation = await provider.generateStructured(
        {
          requestId: `reconcile-${runId}`,
          taskKind: "reconciliation",
          instructions: [
            "Pairs of excerpts from different sources appear to disagree. For each pair (by index):",
            "1. State the exact point of conflict.",
            "2. Classify it: factual disagreement vs difference of interpretation vs methodology vs timing.",
            "3. Check publication dates — newer information may supersede older reporting.",
            "4. Prefer primary sources and stronger methodology where the metadata supports it.",
            "5. If the conflict cannot be resolved from the given material, say 'unresolved' — NEVER pretend a disagreement is settled.",
          ].join("\n"),
          data: fenced.text,
          context: {
            pairs: conflicts.map((pair) => ({
              a: {
                claim: pair.a.claim,
                excerpt: pair.a.evidenceText,
                sourceTitle: pair.a.sourceTitle,
                publishedAt: pair.a.sourcePublishedAt?.toISOString(),
                quality: pair.a.sourceQuality,
                classification: pair.a.sourceClassification,
              },
              b: {
                claim: pair.b.claim,
                excerpt: pair.b.evidenceText,
                sourceTitle: pair.b.sourceTitle,
                publishedAt: pair.b.sourcePublishedAt?.toISOString(),
                quality: pair.b.sourceQuality,
                classification: pair.b.sourceClassification,
              },
              signal: pair.signal,
            })),
          },
          schemaDescription: RECONCILIATION_SCHEMA_DESCRIPTION,
        },
        reconciliationOutputSchema
      );

      for (const item of reconciliation.disagreements) {
        const pair = conflicts[item.pairIndex];
        if (!pair) continue;
        const claim = await prisma.claim.create({
          data: {
            id: newId("clm"),
            projectId: project.id,
            text: item.topic.slice(0, 490),
            statementKind: "uncertain",
            verificationStatus: "disputed",
            statusExplanation: `${item.conflictPoint} — ${item.assessment}`.slice(0, 1900),
          },
        });
        await prisma.claimEvidence.createMany({
          data: [
            { id: newId("ce"), claimId: claim.id, evidenceId: pair.a.id, stance: "supports" },
            { id: newId("ce"), claimId: claim.id, evidenceId: pair.b.id, stance: "opposes" },
          ],
          skipDuplicates: true,
        });
        disagreements.push({
          topic: item.topic,
          conflictPoint: item.conflictPoint,
          kind: item.kind,
          resolution: item.resolution,
          assessment: item.assessment,
          confidenceNote: item.confidenceNote,
          evidenceIdA: pair.a.id,
          evidenceIdB: pair.b.id,
        });
      }
      await deps.emit(
        "reconciling-disagreements",
        `Reconciled ${disagreements.length} disagreement(s); ${disagreements.filter((d) => d.resolution === "unresolved").length} remain unresolved (reported, not hidden)`,
        counters
      );
    } catch (err) {
      await prisma.runEvent.create({
        data: {
          id: newId("ev"),
          runId,
          stage: "reconciling-disagreements",
          message: `Reconciliation failed (${(err as Error).message.slice(0, 200)}); conflicts are still flagged in the evidence stances.`,
        },
      });
    }
  } else {
    await deps.emit("reconciling-disagreements", "No conflicting evidence pairs detected between sources", counters);
  }

  // ---- Stage 8–9: synthesis + mandatory citation verification --------------
  await checkCancelled();
  await synthesizeAndVerify({
    deps,
    runId,
    project,
    provider,
    providerId,
    plan,
    subquestionRows,
    evidenceRows,
    counters,
    discoveryNotes,
    disagreements,
  });

  await deps.emit("complete", "Research run complete", counters);
}
