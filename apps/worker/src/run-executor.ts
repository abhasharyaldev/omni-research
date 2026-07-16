import { getPrisma, type PrismaClient, recordTimelineEvent } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { newId, type ProgressEvent, type ResearchStage } from "@omni/shared";
import { redactSecrets } from "@omni/security";
import { RunCancelledError, runResearchPipeline, type PipelineDeps } from "@omni/research-engine";
import { buildNewsBriefing } from "@omni/news-engine";

/**
 * Claim one queued run (atomically) and execute the pipeline for it.
 * Returns true when a run was claimed.
 */
export async function claimAndExecuteRun(prisma: PrismaClient = getPrisma()): Promise<boolean> {
  await recoverStaleRunningRuns(prisma);

  const candidate = await prisma.researchRun.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return false;

  const claimed = await prisma.researchRun.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "running", startedAt: new Date(), error: null },
  });
  if (claimed.count !== 1) return false; // lost the race to another worker

  await executeRun(prisma, candidate.id);
  return true;
}

function staleRunCutoff(): Date {
  const staleAfterMs = Number(process.env.STALE_RUN_AFTER_MS || 60_000);
  return new Date(Date.now() - staleAfterMs);
}

export async function recoverStaleRunningRuns(prisma: PrismaClient = getPrisma()): Promise<number> {
  const staleRuns = await prisma.researchRun.findMany({
    where: { status: "running", updatedAt: { lt: staleRunCutoff() } },
    select: { id: true, stage: true },
    take: 10,
  });
  for (const run of staleRuns) {
    const recovered = await prisma.researchRun.updateMany({
      where: { id: run.id, status: "running", updatedAt: { lt: staleRunCutoff() } },
      data: {
        status: "queued",
        cancelRequested: false,
        error: `Recovered from stale running state at stage "${run.stage}". The previous worker stopped before finishing; retrying with saved work.`,
      },
    });
    if (recovered.count === 1) {
      await prisma.runEvent.create({
        data: {
          id: newId("ev"),
          runId: run.id,
          stage: run.stage,
          message: "Recovered stale running run and re-queued it. Saved crawl/source work will be reused where possible.",
        },
      });
      console.log(`[worker] recovered stale run ${run.id} from ${run.stage}`);
    }
  }
  return staleRuns.length;
}

export async function executeRun(prisma: PrismaClient, runId: string): Promise<void> {
  const providers = getProviderManager();
  const heartbeat = setInterval(() => {
    prisma.researchRun
      .update({ where: { id: runId }, data: { updatedAt: new Date() } })
      .catch(() => undefined);
  }, 15_000);

  const emit: PipelineDeps["emit"] = async (
    stage: ResearchStage,
    message: string,
    counters: ProgressEvent["counters"],
    extra?: Record<string, unknown>
  ) => {
    await prisma.researchRun.update({
      where: { id: runId },
      data: {
        stage,
        countersJson: counters as object,
        ...(extra?.provider ? { providerUsed: String(extra.provider) } : {}),
      },
    });
    await prisma.runEvent.create({
      data: { id: newId("ev"), runId, stage, message: message.slice(0, 900), dataJson: (extra as object) ?? undefined },
    });
    console.log(`[worker] run ${runId} :: ${stage} :: ${message}`);
  };

  const isCancelled = async () => {
    const row = await prisma.researchRun.findUnique({
      where: { id: runId },
      select: { cancelRequested: true },
    });
    return Boolean(row?.cancelRequested);
  };

  try {
    await runResearchPipeline({ prisma, providers, emit, isCancelled, storageRoot: ".local-data" }, runId);

    // Post-pipeline step for news projects: cluster + timeline.
    const run = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId }, include: { project: true } });
    if (run.project.mode === "news-catchup") {
      await prisma.newsEvent.deleteMany({ where: { projectId: run.projectId } });
      await buildNewsBriefing(prisma, providers, run.projectId);
      await prisma.runEvent.create({
        data: { id: newId("ev"), runId, stage: "complete", message: "News briefing clustered and summarized" },
      });
    }

    await prisma.researchRun.update({
      where: { id: runId },
      data: { status: "completed", finishedAt: new Date(), cancelRequested: false },
    });
    await recordTimelineEvent(prisma, { projectId: run.projectId, type: "run-completed", actor: "system", summary: "Research run completed", entityType: "run", entityId: runId });
  } catch (err) {
    if (err instanceof RunCancelledError) {
      const run = await prisma.researchRun.findUnique({ where: { id: runId }, select: { error: true } });
      const paused = run?.error === "pause-requested";
      await prisma.researchRun.update({
        where: { id: runId },
        data: {
          status: paused ? "paused" : "cancelled",
          finishedAt: paused ? null : new Date(),
          cancelRequested: false,
          error: null,
        },
      });
      await prisma.runEvent.create({
        data: {
          id: newId("ev"),
          runId,
          stage: "complete",
          message: paused
            ? "Run paused at a stage boundary. Completed work is saved; resume to continue."
            : "Run cancelled. All completed work (sources, evidence) is saved.",
        },
      });
      return;
    }
    const message = redactSecrets((err as Error).message ?? "unknown error").slice(0, 1900);
    console.error(`[worker] run ${runId} failed:`, message);
    await prisma.researchRun.update({
      where: { id: runId },
      data: { status: "failed", finishedAt: new Date(), error: message },
    });
    const failedRun = await prisma.researchRun.findUnique({ where: { id: runId }, select: { projectId: true } });
    if (failedRun) {
      await recordTimelineEvent(prisma, { projectId: failedRun.projectId, type: "run-failed", actor: "system", summary: `Research run failed: ${message.slice(0, 120)}`, entityType: "run", entityId: runId });
    }
    await prisma.runEvent.create({
      data: {
        id: newId("ev"),
        runId,
        stage: "complete",
        message: `Run failed: ${message}. Work completed before the failure (sources, evidence) is preserved.`,
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
}
