import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { sleep } from "@omni/shared";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireRun } from "../util.js";

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  const staleRunCutoff = () => {
    const staleAfterMs = Number(process.env.STALE_RUN_AFTER_MS || 60_000);
    return new Date(Date.now() - staleAfterMs);
  };

  app.get("/api/research-runs/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireRun(id, user.id);
    const run = await prisma.researchRun.findUnique({
      where: { id },
      include: {
        subquestions: { orderBy: { order: "asc" } },
        queries: true,
        crawlRequests: { orderBy: { createdAt: "asc" }, take: 500 },
        reports: { select: { id: true, title: true, verifiedAt: true } },
      },
    });
    return { run };
  });

  app.post("/api/research-runs/:id/cancel", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const run = await requireRun(id, user.id);
    if (!["queued", "running", "paused"].includes(run.status)) {
      throw new ApiHttpError(409, "not-cancellable", `Run is already ${run.status}`);
    }
    await prisma.researchRun.update({
      where: { id },
      data: { cancelRequested: true, ...(run.status === "queued" || run.status === "paused" ? { status: "cancelled", finishedAt: new Date() } : {}) },
    });
    await audit(user.id, "run.cancel", "research-run", id, request);
    return { ok: true };
  });

  app.post("/api/research-runs/:id/pause", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const run = await requireRun(id, user.id);
    if (run.status !== "running" && run.status !== "queued") {
      throw new ApiHttpError(409, "not-pausable", `Run is ${run.status}; only queued/running runs can pause`);
    }
    // Cooperative pause: the worker checks this flag between stages.
    await prisma.researchRun.update({
      where: { id },
      data: run.status === "queued" ? { status: "paused" } : { cancelRequested: true, error: "pause-requested" },
    });
    await audit(user.id, "run.pause", "research-run", id, request);
    return {
      ok: true,
      note: "Pause takes effect at the next stage boundary. Completed work is saved; Resume re-queues the run and already-saved sources are reused.",
    };
  });

  app.post("/api/research-runs/:id/resume", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const run = await requireRun(id, user.id);
    const isStaleRunning = run.status === "running" && run.updatedAt < staleRunCutoff();
    const isPausePending = run.status === "running" && run.error === "pause-requested";
    if (run.status !== "paused" && run.status !== "cancelled" && run.status !== "failed" && !isStaleRunning && !isPausePending) {
      throw new ApiHttpError(409, "not-resumable", `Run is ${run.status}`);
    }
    await prisma.researchRun.update({
      where: { id },
      data: {
        status: isPausePending ? "running" : "queued",
        cancelRequested: false,
        error: isStaleRunning
          ? `Recovered from stale running state at stage "${run.stage}". Retrying with saved work.`
          : null,
      },
    });
    await audit(user.id, "run.resume", "research-run", id, request);
    return { ok: true };
  });

  /**
   * Server-Sent Events for live progress. Events reflect REAL persisted
   * backend state (run row + RunEvent log) — nothing simulated.
   */
  app.get("/api/research-runs/:id/events", async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireRun(id, user.id);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();

    let lastEventAt = new Date(0);
    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for (let i = 0; i < 60 * 30 && !closed; i++) {
        const run = await prisma.researchRun.findUnique({
          where: { id },
          select: { status: true, stage: true, countersJson: true, error: true, providerUsed: true, startedAt: true, finishedAt: true },
        });
        if (!run) break;

        const events = await prisma.runEvent.findMany({
          where: { runId: id, createdAt: { gt: lastEventAt } },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
        for (const event of events) {
          lastEventAt = event.createdAt;
          send("log", {
            stage: event.stage,
            message: event.message,
            data: event.dataJson,
            at: event.createdAt.toISOString(),
          });
        }
        send("state", {
          status: run.status,
          stage: run.stage,
          counters: run.countersJson,
          error: run.error,
          provider: run.providerUsed,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          at: new Date().toISOString(),
        });
        if (["completed", "failed", "cancelled", "paused"].includes(run.status)) break;
        await sleep(1000);
      }
    } finally {
      if (!closed) reply.raw.end();
    }
  });
}
