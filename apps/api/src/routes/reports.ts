import type { FastifyInstance } from "fastify";
import { getPrisma, recordTimelineEvent } from "@omni/database";
import { exportSchema, newId, type CitationStyle } from "@omni/shared";
import { buildDocxExport, buildPdfExport, buildExport } from "@omni/research-engine";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get("/api/projects/:id/evidence", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const evidence = await prisma.evidence.findMany({
      where: { projectId: id },
      include: { source: { select: { id: true, title: true, url: true, finalUrl: true, publisher: true, publishedAt: true } } },
      orderBy: { relevanceScore: "desc" },
      take: 500,
    });
    return { evidence };
  });

  app.get("/api/projects/:id/report", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const report = await prisma.report.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: {
        sections: { orderBy: { order: "asc" } },
        citations: {
          orderBy: { marker: "asc" },
          include: {
            source: true,
            evidence: { select: { evidenceText: true, claim: true, sourceLocation: true, pageNumber: true } },
          },
        },
      },
    });
    return { report };
  });

  app.post("/api/projects/:id/report/regenerate", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const active = await prisma.researchRun.findFirst({
      where: { projectId: id, status: { in: ["queued", "running"] } },
    });
    if (active) throw new ApiHttpError(409, "run-active", "A run is already in progress");
    const run = await prisma.researchRun.create({
      data: { id: newId("run"), projectId: id, status: "queued" },
    });
    await audit(user.id, "report.regenerate", "project", id, request);
    return { run };
  });

  app.post("/api/projects/:id/export", async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const input = exportSchema.parse(request.body);
    if (input.format === "docx" || input.format === "pdf") {
      const builder = input.format === "docx" ? buildDocxExport : buildPdfExport;
      const binary = await builder(prisma, id, input.citationStyle as CitationStyle | undefined);
      await prisma.export.create({
        data: { id: newId("exp"), projectId: id, format: input.format, settingsJson: { filename: binary.filename, bytes: binary.buffer.length } },
      });
      await recordTimelineEvent(prisma, { projectId: id, type: "export-created", summary: `Export created (${input.format})`, entityType: "report" });
      await audit(user.id, "project.export", "project", id, request, { format: input.format });
      reply.header("content-type", binary.mimeType);
      reply.header("content-disposition", `attachment; filename="${binary.filename}"`);
      return reply.send(binary.buffer);
    }
    const result = await buildExport(prisma, id, input.format, input.citationStyle as CitationStyle | undefined);
    await prisma.export.create({
      data: {
        id: newId("exp"),
        projectId: id,
        format: input.format,
        contentText: result.content.slice(0, 500_000),
        settingsJson: { citationStyle: input.citationStyle ?? null },
      },
    });
    await audit(user.id, "project.export", "project", id, request, { format: input.format });
    reply.header("content-type", `${result.mimeType}; charset=utf-8`);
    reply.header("content-disposition", `attachment; filename="${result.filename}"`);
    return reply.send(result.content);
  });
}
