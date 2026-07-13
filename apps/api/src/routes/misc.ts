import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { factCheckSchema, type ProviderId } from "@omni/shared";
import { factCheckClaims } from "@omni/research-engine";
import { buildNewsBriefing } from "@omni/news-engine";
import { requireUser } from "../auth.js";
import { audit, requireProject } from "../util.js";

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const providers = getProviderManager();

  app.get("/api/health", async () => {
    let database = "unavailable";
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = "ready";
    } catch {
      /* reported as unavailable */
    }
    return { ok: database === "ready", database, time: new Date().toISOString() };
  });

  app.post("/api/projects/:id/fact-check", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const project = await requireProject(id, user.id);
    const input = factCheckSchema.parse(request.body);
    const results = await factCheckClaims(
      prisma,
      providers,
      id,
      input.claims,
      (project.provider as ProviderId | null) ?? (user.defaultProvider as ProviderId)
    );
    await audit(user.id, "fact-check.run", "project", id, request, { claims: input.claims.length });
    return { results };
  });

  app.get("/api/projects/:id/news", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const events = await prisma.newsEvent.findMany({
      where: { projectId: id },
      orderBy: { eventDate: "desc" },
      include: {
        articles: {
          include: {
            source: { select: { id: true, title: true, url: true, finalUrl: true, publisher: true, publishedAt: true } },
          },
        },
      },
    });
    return { events };
  });

  app.post("/api/projects/:id/news/rebuild", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const project = await requireProject(id, user.id);
    await prisma.newsEvent.deleteMany({ where: { projectId: id } });
    const result = await buildNewsBriefing(
      prisma,
      providers,
      id,
      (project.provider as ProviderId | null) ?? (user.defaultProvider as ProviderId)
    );
    await audit(user.id, "news.rebuild", "project", id, request);
    return result;
  });

  app.get("/api/projects/:id/claims", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const claims = await prisma.claim.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: { evidence: { include: { evidence: { include: { source: { select: { title: true, url: true } } } } } } },
      take: 100,
    });
    return { claims };
  });
}
