/**
 * Seed: creates a demo user and a demo research project wired to the local
 * fixture website, then (optionally) executes one real research run through
 * the full pipeline with the mock provider so a cited demo report exists.
 *
 * Usage:
 *   pnpm db:seed             — seed user + project
 *   pnpm db:seed -- --run    — also execute the demo research run now
 *
 * Demo login: demo@omniresearch.local / demo-password-123
 */
import bcrypt from "bcryptjs";
import { bootstrapDatabase, getPrisma } from "@omni/database";
import { newId } from "@omni/shared";
import { startFixtureServer } from "../fixtures/serve-lib.js";

async function main(): Promise<void> {
  const runNow = process.argv.includes("--run");
  await bootstrapDatabase({ migrate: true });
  const prisma = getPrisma();

  const email = "demo@omniresearch.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        id: newId("usr"),
        email,
        passwordHash: await bcrypt.hash("demo-password-123", 11),
        displayName: "Demo User",
        defaultProvider: "mock",
      },
    });
    console.log(`✓ Created demo user ${email} (password: demo-password-123)`);
  } else {
    console.log(`✓ Demo user already exists (${email})`);
  }

  const fixtureBase = `http://127.0.0.1:${Number(process.env.FIXTURE_PORT || 4799)}`;
  const title = "Demo: spaced repetition and learning science";
  let project = await prisma.project.findFirst({ where: { ownerId: user.id, title } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        id: newId("prj"),
        ownerId: user.id,
        title,
        mode: "deep-research",
        prompt:
          "Research how spaced repetition and evidence-based study techniques improve long-term retention, and compare which techniques have the strongest evidence.",
        citationStyle: "web",
        maxSources: 6,
        storeFullText: true,
        startingUrls: [
          `${fixtureBase}/articles/spaced-repetition.html`,
          `${fixtureBase}/articles/learning-science.html`,
          `${fixtureBase}/articles/injection-attempt.html`,
        ],
        provider: "mock",
        topics: {
          create: [
            { id: newId("top"), name: "Spaced repetition", order: 0 },
            { id: newId("top"), name: "Evidence-based study techniques", order: 1 },
          ],
        },
      },
    });
    console.log(`✓ Created demo project "${title}" using the local fixture site (${fixtureBase})`);
  } else {
    console.log(`✓ Demo project already exists`);
  }

  if (runNow) {
    process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS = "1"; // fixture site runs on 127.0.0.1
    const server = await startFixtureServer(Number(process.env.FIXTURE_PORT || 4799)).catch(() => null);
    try {
      const existing = await prisma.researchRun.findFirst({
        where: { projectId: project.id, status: { in: ["queued", "running"] } },
      });
      if (existing) {
        console.log("· A run is already queued/running; skipping");
      } else {
        const run = await prisma.researchRun.create({
          data: { id: newId("run"), projectId: project.id, status: "running", startedAt: new Date() },
        });
        console.log(`… Executing demo research run ${run.id} with the mock provider (real crawl of the fixture site)`);
        const { executeRun } = await import("../apps/worker/src/run-executor.js");
        await executeRun(prisma, run.id);
        const final = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
        if (final.status !== "completed") {
          console.error(`❌ Demo run ended with status "${final.status}": ${final.error ?? ""}`);
          process.exitCode = 1;
        } else {
          const citations = await prisma.citation.count({ where: { report: { projectId: project.id } } });
          console.log(`✓ Demo run completed with ${citations} verified citation(s). Sign in and open the project.`);
        }
      }
    } finally {
      await server?.close();
    }
  } else {
    console.log("\nSeed complete. To also execute the demo run now: pnpm db:seed -- --run");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
