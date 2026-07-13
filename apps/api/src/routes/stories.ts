import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { newId } from "@omni/shared";
import { StorytellingEngine, buildResearchPackage, createStorySchema } from "@omni/story-engine";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

const STAGES = ["blueprint", "outline", "hooks", "scenes", "script", "critique"] as const;

async function requireStory(storyId: string, userId: string) {
  const prisma = getPrisma();
  const story = await prisma.story.findUnique({ where: { id: storyId }, include: { project: true } });
  if (!story || story.project.ownerId !== userId) throw new ApiHttpError(404, "not-found", "Story not found");
  return story;
}

export async function registerStoryRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const engine = new StorytellingEngine(prisma, getProviderManager());

  /** Honest skill availability report (no invocation, no usage consumed). */
  app.get("/api/storytelling/status", async (request) => {
    requireUser(request);
    const status = engine.status();
    return {
      integration: status.integration, // "claude-skill" | "fallback"
      storytelling: status.storytelling
        ? { id: status.storytelling.id, description: status.storytelling.description, path: status.storytelling.filePath, hash: status.storytelling.contentHash, source: status.storytelling.source }
        : null,
      viralHooks: status.viralHooks
        ? { id: status.viralHooks.id, path: status.viralHooks.filePath, hash: status.viralHooks.contentHash }
        : null,
      searchedPaths: status.searchedPaths,
      detectedAt: status.detectedAt,
    };
  });

  app.post("/api/projects/:id/stories", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const project = await requireProject(id, user.id);
    const body = (request.body ?? {}) as { title?: string; settings?: unknown };
    const settings = createStorySchema.parse(body.settings ?? {});
    const storyId = await engine.createStory(id, body.title?.trim() || `${project.title} — story`, settings);
    await audit(user.id, "story.create", "story", storyId, request);
    const story = await prisma.story.findUnique({ where: { id: storyId } });
    return { story };
  });

  app.get("/api/projects/:id/stories", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const stories = await prisma.story.findMany({
      where: { projectId: id },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    return { stories };
  });

  app.get("/api/stories/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireStory(id, user.id);
    const story = await prisma.story.findUnique({
      where: { id },
      include: {
        versions: { orderBy: [{ kind: "asc" }, { version: "desc" }] },
        invocations: { orderBy: { createdAt: "desc" }, take: 30 },
        lockedFacts: true,
      },
    });
    // Latest version per kind (all versions kept for restore).
    const latestByKind: Record<string, unknown> = {};
    const versionsByKind: Record<string, number> = {};
    for (const version of story!.versions) {
      if (!(version.kind in latestByKind)) {
        latestByKind[version.kind] = version.contentJson;
        versionsByKind[version.kind] = version.version;
      }
    }
    return {
      story: {
        ...story,
        versions: undefined,
        artifacts: latestByKind,
        artifactVersions: versionsByKind,
      },
    };
  });

  app.post("/api/stories/:id/generate/:stage", async (request) => {
    const user = requireUser(request);
    const { id, stage } = request.params as { id: string; stage: string };
    await requireStory(id, user.id);
    if (!STAGES.includes(stage as (typeof STAGES)[number])) {
      throw new ApiHttpError(400, "invalid-stage", `stage must be one of ${STAGES.join(", ")}`);
    }
    // Ordering guard: a script needs a blueprint first; critique needs a script.
    if (stage !== "blueprint") {
      const blueprint = await prisma.storyVersion.findFirst({ where: { storyId: id, kind: "blueprint" } });
      if (!blueprint) throw new ApiHttpError(409, "missing-blueprint", "Generate the blueprint first — the workflow is Research → Blueprint → Outline → Script → Validate.");
    }
    if (stage === "critique") {
      const script = await prisma.storyVersion.findFirst({ where: { storyId: id, kind: "script" } });
      if (!script) throw new ApiHttpError(409, "missing-script", "Generate the script before requesting a critique.");
    }
    const result = await engine.generate(id, stage as (typeof STAGES)[number]);
    await audit(user.id, `story.generate.${stage}`, "story", id, request, { method: result.invocation.method });
    return result;
  });

  app.post("/api/stories/:id/validate", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireStory(id, user.id);
    const result = await engine.validate(id);
    await audit(user.id, "story.validate", "story", id, request, { verdict: result.verdict });
    return { result };
  });

  app.post("/api/stories/:id/lock-fact", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const story = await requireStory(id, user.id);
    const body = (request.body ?? {}) as { evidenceRef?: string };
    if (!body.evidenceRef?.match(/^E\d{1,3}$/)) throw new ApiHttpError(400, "invalid-ref", "evidenceRef must look like E1");
    const pkg = await buildResearchPackage(prisma, story.projectId);
    const evidence = pkg.evidence.find((e) => e.ref === body.evidenceRef);
    if (!evidence) throw new ApiHttpError(404, "not-found", `No evidence ${body.evidenceRef} in the current research package`);
    const locked = await prisma.storyLockedFact.upsert({
      where: { storyId_evidenceRef: { storyId: id, evidenceRef: evidence.ref } },
      create: { id: newId("slf"), storyId: id, evidenceRef: evidence.ref, evidenceId: evidence.evidenceId, text: evidence.claim },
      update: {},
    });
    await audit(user.id, "story.lock-fact", "story", id, request);
    return { locked };
  });

  app.delete("/api/stories/:id/lock-fact/:ref", async (request) => {
    const user = requireUser(request);
    const { id, ref } = request.params as { id: string; ref: string };
    await requireStory(id, user.id);
    await prisma.storyLockedFact.deleteMany({ where: { storyId: id, evidenceRef: ref } });
    return { ok: true };
  });

  /** The research package as the script editor shows it (evidence drill-down). */
  app.get("/api/stories/:id/package", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const story = await requireStory(id, user.id);
    const pkg = await buildResearchPackage(prisma, story.projectId);
    return { package: pkg };
  });
}
