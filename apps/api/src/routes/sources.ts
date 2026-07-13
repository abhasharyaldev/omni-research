import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { addSourceSchema, newId } from "@omni/shared";
import { normalizeUrl } from "@omni/crawler";
import { validateUrlSyntax } from "@omni/security";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject, requireSource } from "../util.js";

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get("/api/projects/:id/sources", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const query = request.query as { q?: string; classification?: string; sort?: string };
    const sources = await prisma.source.findMany({
      where: {
        projectId: id,
        ...(query.q
          ? {
              OR: [
                { title: { contains: query.q, mode: "insensitive" } },
                { url: { contains: query.q, mode: "insensitive" } },
                { publisher: { contains: query.q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(query.classification ? { classification: query.classification } : {}),
      },
      orderBy:
        query.sort === "date"
          ? { publishedAt: "desc" }
          : query.sort === "retrieved"
            ? { retrievedAt: "desc" }
            : { qualityScore: "desc" },
      include: { tags: { include: { tag: true } }, _count: { select: { evidence: true, duplicates: true } } },
      take: 500,
    });
    return { sources };
  });

  app.post("/api/projects/:id/sources", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const input = addSourceSchema.parse(request.body);
    const verdict = validateUrlSyntax(input.url);
    if (!verdict.ok) {
      throw new ApiHttpError(400, "unsafe-url", `URL rejected: ${verdict.detail}`);
    }
    const normalized = normalizeUrl(input.url);
    if (!normalized) throw new ApiHttpError(400, "invalid-url", "URL could not be normalized");
    const source = await prisma.source.upsert({
      where: { projectId_normalizedUrl: { projectId: id, normalizedUrl: normalized } },
      create: {
        id: newId("src"),
        projectId: id,
        url: input.url,
        normalizedUrl: normalized,
        status: "pending", // crawled on the next research run
        discoveredBy: "user",
      },
      update: {},
    });
    // Also add to the project's starting URLs so the next run crawls it.
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    const startingUrls = new Set([...(project.startingUrls as string[]), input.url]);
    await prisma.project.update({ where: { id }, data: { startingUrls: [...startingUrls] } });
    await audit(user.id, "source.add", "source", source.id, request);
    return { source };
  });

  app.get("/api/sources/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireSource(id, user.id);
    const source = await prisma.source.findUnique({
      where: { id },
      include: {
        snapshots: { select: { id: true, kind: true, bytes: true, createdAt: true } },
        evidence: { take: 100 },
        duplicates: { select: { id: true, url: true, title: true } },
      },
    });
    return { source };
  });

  app.patch("/api/sources/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireSource(id, user.id);
    const body = (request.body ?? {}) as { status?: string };
    if (body.status && !["retrieved", "archived"].includes(body.status)) {
      throw new ApiHttpError(400, "invalid-status", "status must be retrieved or archived");
    }
    const source = await prisma.source.update({
      where: { id },
      data: { ...(body.status ? { status: body.status } : {}) },
    });
    await audit(user.id, "source.update", "source", id, request);
    return { source };
  });

  app.delete("/api/sources/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireSource(id, user.id);
    await audit(user.id, "source.delete", "source", id, request);
    await prisma.source.delete({ where: { id } });
    return { ok: true };
  });

  app.post("/api/sources/:id/recrawl", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const source = await requireSource(id, user.id);
    // Re-crawling happens through a research run so all safety policies apply.
    const active = await prisma.researchRun.findFirst({
      where: { projectId: source.projectId, status: { in: ["queued", "running"] } },
    });
    if (active) throw new ApiHttpError(409, "run-active", "Wait for the active run to finish");
    const project = await prisma.project.findUniqueOrThrow({ where: { id: source.projectId } });
    const startingUrls = new Set([...(project.startingUrls as string[]), source.url]);
    await prisma.project.update({
      where: { id: source.projectId },
      data: { startingUrls: [...startingUrls] },
    });
    const run = await prisma.researchRun.create({
      data: {
        id: newId("run"),
        projectId: source.projectId,
        status: "queued",
        limitsJson: { maxPagesPerRun: 3, maxDepth: 0, recrawlUrl: source.url } as object,
      },
    });
    await audit(user.id, "source.recrawl", "source", id, request);
    return { run };
  });
}
