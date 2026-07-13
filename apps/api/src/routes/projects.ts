import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import {
  clampCrawlLimits,
  createProjectSchema,
  newId,
  previewRunSchema,
  startRunSchema,
  updateProjectSchema,
} from "@omni/shared";
import { getProviderManager } from "@omni/ai-providers";
import { buildRunPreview } from "@omni/research-engine";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.post("/api/projects", async (request) => {
    const user = requireUser(request);
    const input = createProjectSchema.parse(request.body);
    const project = await prisma.project.create({
      data: {
        id: newId("prj"),
        ownerId: user.id,
        title: input.title,
        mode: input.mode,
        prompt: input.prompt,
        gradeLevel: input.gradeLevel,
        expertiseLevel: input.expertiseLevel,
        audience: input.audience,
        region: input.region,
        dateRangeStart: input.dateRangeStart,
        dateRangeEnd: input.dateRangeEnd,
        maxSources: input.maxSources,
        citationStyle: input.citationStyle,
        outputFormat: input.outputFormat,
        startingUrls: input.startingUrls,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
        assignment: input.assignmentInstructions,
        rubric: input.rubric,
        crawlLimits: input.crawlLimits ? (clampCrawlLimits(input.crawlLimits) as object) : undefined,
        provider: input.provider,
        retentionDays: Number(process.env.SOURCE_CONTENT_RETENTION_DAYS || 30),
        storeFullText: (process.env.STORE_FULL_SOURCE_CONTENT ?? "").toLowerCase() === "true",
        topics: {
          create: input.topics.map((name, order) => ({ id: newId("top"), name, order })),
        },
      },
      include: { topics: true },
    });
    await audit(user.id, "project.create", "project", project.id, request);
    return { project };
  });

  app.get("/api/projects", async (request) => {
    const user = requireUser(request);
    const projects = await prisma.project.findMany({
      where: { ownerId: user.id, status: "active" },
      orderBy: { updatedAt: "desc" },
      include: {
        topics: { orderBy: { order: "asc" } },
        runs: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { sources: true, reports: true } },
      },
      take: 100,
    });
    return { projects };
  });

  app.get("/api/projects/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        topics: { orderBy: { order: "asc" } },
        runs: { orderBy: { createdAt: "desc" } },
        reports: { orderBy: { createdAt: "desc" }, select: { id: true, title: true, createdAt: true, verifiedAt: true, providerUsed: true } },
        learningPlans: { select: { id: true, subject: true, kind: true, status: true } },
        _count: { select: { sources: true, evidence: true } },
      },
    });
    return { project };
  });

  app.patch("/api/projects/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const input = updateProjectSchema.parse(request.body);
    const project = await prisma.project.update({
      where: { id },
      data: {
        title: input.title,
        prompt: input.prompt,
        gradeLevel: input.gradeLevel,
        maxSources: input.maxSources,
        citationStyle: input.citationStyle,
        startingUrls: input.startingUrls,
        includeDomains: input.includeDomains,
        excludeDomains: input.excludeDomains,
        crawlLimits: input.crawlLimits ? (clampCrawlLimits(input.crawlLimits) as object) : undefined,
        provider: input.provider,
      },
    });
    await audit(user.id, "project.update", "project", id, request);
    return { project };
  });

  app.delete("/api/projects/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    await audit(user.id, "project.delete", "project", id, request);
    await prisma.project.delete({ where: { id } });
    return { ok: true };
  });

  // ---- research runs -------------------------------------------------------

  /**
   * Run preview: plan + discovery + candidate scoring + robots pre-check,
   * WITHOUT crawling any content page. The user reviews/edits the candidate
   * list, then approves via POST /research-runs with approvedUrls.
   */
  app.post("/api/projects/:id/research-runs/preview", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const input = previewRunSchema.parse(request.body ?? {});
    const preview = await buildRunPreview(prisma, getProviderManager(), id, {
      maxSources: input.maxSources,
      crawlLimits: input.crawlLimits,
      excludeDomains: input.excludeDomains,
      extraUrls: input.extraUrls,
    });
    await audit(user.id, "run.preview", "project", id, request, {
      candidates: preview.candidates.length,
    });
    return { preview };
  });

  app.post("/api/projects/:id/research-runs", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const project = await requireProject(id, user.id);
    const input = startRunSchema.parse(request.body ?? {});

    const active = await prisma.researchRun.findFirst({
      where: { projectId: id, status: { in: ["queued", "running"] } },
    });
    if (active) {
      throw new ApiHttpError(409, "run-active", "A research run is already queued or running for this project");
    }

    const limits = clampCrawlLimits({
      ...((project.crawlLimits as object | null) ?? {}),
      ...(input.planOverrides?.crawlLimits ?? {}),
    });

    // Run settings ride along in limitsJson: crawl limits + preview approvals
    // + reasoning-loop bounds. The pipeline clamps everything again server-side.
    const runSettings = {
      ...limits,
      ...(input.approvedUrls?.length ? { approvedUrls: input.approvedUrls.slice(0, 300) } : {}),
      ...(input.excludedUrls?.length ? { excludedUrls: input.excludedUrls.slice(0, 300) } : {}),
      ...(input.excludeDomains?.length ? { excludeDomains: input.excludeDomains } : {}),
      ...(input.maxResearchTurns !== undefined ? { maxResearchTurns: input.maxResearchTurns } : {}),
      ...(input.maxSources !== undefined ? { maxSources: input.maxSources } : {}),
      ...(input.highQualityOnly !== undefined ? { highQualityOnly: input.highQualityOnly } : {}),
      ...(input.excludeOpinion !== undefined ? { excludeOpinion: input.excludeOpinion } : {}),
    };

    const planJson = input.planJson
      ? input.planJson
      : input.planOverrides?.subquestions
        ? {
            mainQuestion: project.prompt.slice(0, 490),
            subquestions: input.planOverrides.subquestions,
            keyTerms: [],
            discoveryQueries: [],
            sourceCategories: [],
            outline: [],
          }
        : undefined;

    const run = await prisma.researchRun.create({
      data: {
        id: newId("run"),
        projectId: id,
        status: "queued",
        limitsJson: runSettings as object,
        ...(planJson ? { planJson } : {}),
      },
    });
    if (input.planOverrides?.excludeDomains) {
      await prisma.project.update({
        where: { id },
        data: { excludeDomains: input.planOverrides.excludeDomains },
      });
    }
    await audit(user.id, "run.start", "research-run", run.id, request);
    return { run };
  });
}
