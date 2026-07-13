import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { bootstrapDatabase, getPrisma, disconnectPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { buildRunPreview } from "@omni/research-engine";
import { newId } from "@omni/shared";
import { executeRun } from "../src/run-executor.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/serve-lib.js";

/**
 * Upgrade integration tests: run preview (no crawling) and the multi-turn
 * reasoning loop (gap detection → follow-up discovery → crawl → extract),
 * using the mock provider and mock search fixtures against the local fixture
 * site with a real database.
 */
let db: DatabaseBootstrapResult;
let server: FixtureServer;
let base: string;
let userId: string;

beforeAll(async () => {
  process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS = "1";
  process.env.AI_PROVIDER = "mock";
  db = await bootstrapDatabase({ migrate: true });
  server = await startFixtureServer(0);
  base = `http://127.0.0.1:${server.port}`;
  const prisma = getPrisma();
  const user = await prisma.user.create({
    data: {
      id: newId("usr"),
      email: `mt-${Date.now()}@local.test`,
      passwordHash: await bcrypt.hash("integration-test-pw", 4),
      displayName: "Multi-turn Tester",
    },
  });
  userId = user.id;
}, 300_000);

afterAll(async () => {
  await server?.close();
  await disconnectPrisma();
  await db?.stop?.();
  delete process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS;
});

describe("run preview (no content crawling)", () => {
  it("returns plan, scored candidates, robots pre-checks, and workload — without creating sources", async () => {
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        id: newId("prj"),
        ownerId: userId,
        title: "Preview test project",
        mode: "deep-research",
        prompt: "Research spaced repetition and study techniques.",
        provider: "mock",
        startingUrls: [
          `${base}/articles/spaced-repetition.html`,
          `${base}/private/secret.html`, // robots-disallowed — must be flagged, not crawled
        ],
        topics: { create: [{ id: newId("top"), name: "Spaced repetition", order: 0 }] },
      },
    });

    const preview = await buildRunPreview(prisma, getProviderManager(), project.id, {});
    expect(preview.plan.subquestions.length).toBeGreaterThan(0);
    expect(preview.candidates.length).toBe(2);

    const allowed = preview.candidates.find((c) => c.url.includes("spaced-repetition"))!;
    expect(allowed.robots).toBe("allowed");
    expect(allowed.included).toBe(true);
    expect(allowed.providerId).toBe("manual-urls");

    const blocked = preview.candidates.find((c) => c.url.includes("/private/"))!;
    expect(blocked.robots).toBe("disallowed");
    expect(blocked.included).toBe(false);

    expect(preview.workload.plannedPages).toBeGreaterThan(0);
    expect(preview.workload.note).not.toMatch(/\d+\s*(seconds|minutes)/i); // no fake time estimates

    // Preview must not crawl: no sources or crawl requests exist yet.
    expect(await prisma.source.count({ where: { projectId: project.id } })).toBe(0);
  }, 120_000);
});

describe("multi-turn reasoning loop", () => {
  it("detects evidence gaps, runs follow-up discovery, and records concise decisions", async () => {
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        id: newId("prj"),
        ownerId: userId,
        title: "Multi-turn test project",
        mode: "deep-research",
        prompt: "Research spaced repetition, retrieval practice, and interleaving.",
        provider: "mock",
        maxSources: 6,
        storeFullText: true,
        // Only ONE starting URL plus mock search fixtures. Three topics
        // produce 9 subquestions (mock plan) vs ~6 evidence records, so the
        // gap check MUST find under-supported subquestions and trigger the
        // reasoning loop.
        startingUrls: [`${base}/articles/spaced-repetition.html`],
        topics: {
          create: [
            { id: newId("top"), name: "Spaced repetition", order: 0 },
            { id: newId("top"), name: "Retrieval practice", order: 1 },
            { id: newId("top"), name: "Interleaving", order: 2 },
          ],
        },
      },
    });
    const run = await prisma.researchRun.create({
      data: {
        id: newId("run"),
        projectId: project.id,
        status: "running",
        startedAt: new Date(),
        limitsJson: {
          maxDepth: 0, // no link-following: extra sources come from search discovery only
          maxResearchTurns: 2,
          mockSearchResults: [
            {
              url: `${base}/articles/learning-science.html`,
              title: "The science of effective studying",
              snippet: "Retrieval practice, spacing, and interleaving beat re-reading.",
              discoveredBy: "search-provider",
            },
          ],
        } as object,
      },
    });

    await executeRun(prisma, run.id);
    const final = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(final.error).toBeNull();
    expect(final.status).toBe("completed");

    const events = await prisma.runEvent.findMany({ where: { runId: run.id } });
    const stages = new Set(events.map((e) => e.stage));
    expect(stages).toContain("identifying-gaps");
    expect(stages).toContain("reconciling-disagreements");

    // The decision note is concise and stored (no hidden reasoning).
    const decision = events.find((e) => e.stage === "identifying-gaps" && e.message?.startsWith("Decision:"));
    expect(decision).toBeTruthy();

    // Search-provider discovery surfaced and crawled the second fixture article.
    const sources = await prisma.source.findMany({ where: { projectId: project.id, duplicateOfId: null } });
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(sources.some((s) => s.url.includes("learning-science"))).toBe(true);

    const followupQuery = await prisma.discoveryQuery.findFirst({
      where: { runId: run.id, providerId: "mock" },
    });
    expect(followupQuery).toBeTruthy();

    // The report still verifies every citation.
    const report = await prisma.report.findFirstOrThrow({
      where: { projectId: project.id },
      include: { citations: true },
    });
    expect(report.verifiedAt).toBeTruthy();
    expect(report.citations.every((c) => c.verified)).toBe(true);
  }, 240_000);
});
