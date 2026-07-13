import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { computeResearchHealth } from "@omni/research-engine";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

const CLAIM_STATUSES = new Set([
  "well-supported", "mostly-supported", "partially-supported", "disputed",
  "weakly-supported", "unsupported", "outdated", "unable-to-verify",
]);
const CLAIM_KINDS = new Set(["fact", "opinion", "inference", "uncertain"]);
const CADENCES: Record<string, number | null> = { manual: null, daily: 1, weekly: 7, monthly: 30 };

/** Research Analyst Layer: claim ledger, health, evidence matrix, watchlist. */
export async function registerAnalystRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get("/api/projects/:id/claim-ledger", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const query = request.query as { status?: string; kind?: string };
    if (query.status && !CLAIM_STATUSES.has(query.status)) throw new ApiHttpError(400, "invalid-status", "Unknown claim status filter");
    if (query.kind && !CLAIM_KINDS.has(query.kind)) throw new ApiHttpError(400, "invalid-kind", "Unknown statement kind filter");

    const claims = await prisma.claim.findMany({
      where: {
        projectId: id,
        ...(query.status ? { verificationStatus: query.status } : {}),
        ...(query.kind ? { statementKind: query.kind } : {}),
      },
      include: {
        evidence: {
          include: {
            evidence: {
              include: {
                source: { select: { id: true, title: true, url: true, finalUrl: true, qualityScore: true, classification: true, publishedAt: true } },
                citations: { select: { marker: true, reportId: true, verified: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return {
      claims: claims.map((claim) => {
        const links = claim.evidence.map((link) => ({
          stance: link.stance,
          evidenceId: link.evidenceId,
          claimText: link.evidence.claim,
          excerpt: link.evidence.evidenceText,
          strength: link.evidence.evidenceStrength,
          source: link.evidence.source,
          citations: link.evidence.citations,
        }));
        return {
          id: claim.id,
          text: claim.text,
          statementKind: claim.statementKind,
          verificationStatus: claim.verificationStatus,
          statusExplanation: claim.statusExplanation,
          createdAt: claim.createdAt,
          supporting: links.filter((l) => l.stance === "supports"),
          opposing: links.filter((l) => l.stance === "opposes"),
          contextual: links.filter((l) => l.stance === "contextual"),
          bestSourceQuality: Math.max(0, ...links.map((l) => l.source.qualityScore)),
        };
      }),
    };
  });

  app.get("/api/projects/:id/health", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    // Prefer the health stored with the latest report; recompute when absent
    // or when ?fresh=1 (both paths are the same deterministic function).
    const fresh = (request.query as { fresh?: string }).fresh === "1";
    if (!fresh) {
      const report = await prisma.report.findFirst({
        where: { projectId: id },
        orderBy: { createdAt: "desc" },
        select: { healthJson: true },
      });
      if (report?.healthJson) return { health: report.healthJson, stored: true };
    }
    const health = await computeResearchHealth(prisma, id);
    return { health, stored: false };
  });

  /** Evidence matrix = per-subquestion coverage from the same health scoring. */
  app.get("/api/projects/:id/evidence-matrix", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const health = await computeResearchHealth(prisma, id);
    return { matrix: health.coverage, overall: health.overall, runId: health.runId };
  });

  app.post("/api/projects/:id/watch", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const body = (request.body ?? {}) as { watched?: boolean; cadence?: string };
    const cadence = body.cadence ?? "manual";
    if (!(cadence in CADENCES)) throw new ApiHttpError(400, "invalid-cadence", "cadence must be manual|daily|weekly|monthly");
    const watched = body.watched ?? true;
    const days = CADENCES[cadence];
    const project = await prisma.project.update({
      where: { id },
      data: {
        watched,
        watchCadence: cadence,
        lastCheckedAt: watched ? new Date() : undefined,
        nextCheckAt: watched && days ? new Date(Date.now() + days * 86_400_000) : null,
      },
    });
    await audit(user.id, "project.watch", "project", id, request, { watched, cadence });
    return { project: { id: project.id, watched: project.watched, watchCadence: project.watchCadence, lastCheckedAt: project.lastCheckedAt, nextCheckAt: project.nextCheckAt } };
  });

  /** Watchlist: monitored projects with what-to-refresh hints. No background
   *  scheduler — refresh reuses the normal research-run flow from the UI. */
  app.get("/api/watchlist", async (request) => {
    const user = requireUser(request);
    const projects = await prisma.project.findMany({
      where: { ownerId: user.id, watched: true, status: "active" },
      orderBy: { nextCheckAt: "asc" },
      select: {
        id: true, title: true, mode: true, watchCadence: true, lastCheckedAt: true, nextCheckAt: true,
        runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, finishedAt: true } },
        _count: { select: { sources: true } },
      },
    });
    const now = Date.now();
    return {
      watchlist: projects.map((p) => ({
        ...p,
        due: p.watchCadence !== "manual" && p.nextCheckAt !== null && p.nextCheckAt.getTime() <= now,
        refreshHint:
          p.watchCadence === "manual"
            ? "Manual cadence — refresh whenever you want new coverage."
            : p.nextCheckAt && p.nextCheckAt.getTime() <= now
              ? `Due since ${p.nextCheckAt.toISOString().slice(0, 10)} — start a run to pick up new/changed sources.`
              : `Next suggested check: ${p.nextCheckAt?.toISOString().slice(0, 10) ?? "unscheduled"}.`,
      })),
    };
  });
}
