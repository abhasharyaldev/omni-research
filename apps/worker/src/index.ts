import { loadRootEnv } from "@omni/shared/env";
import { bootstrapDatabase, cleanupExpiredContent, getPrisma } from "@omni/database";
import { sleep } from "@omni/shared";
import { claimAndExecuteRun } from "./run-executor.js";

loadRootEnv();

/**
 * Research worker: a database-backed job loop (the local queue fallback —
 * no Redis required). Polls for queued runs, claims them atomically, and
 * executes the research pipeline. Runs retention cleanup hourly.
 */
async function main(): Promise<void> {
  const db = await bootstrapDatabase({ migrate: true });
  console.log(`[worker] database ready (${db.mode}); polling for research runs`);
  const prisma = getPrisma();

  let lastCleanup = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const didWork = await claimAndExecuteRun(prisma);
      if (Date.now() - lastCleanup > 3_600_000) {
        lastCleanup = Date.now();
        const { purgedSnapshots } = await cleanupExpiredContent(prisma);
        if (purgedSnapshots > 0) console.log(`[worker] retention cleanup purged ${purgedSnapshots} snapshot(s)`);
      }
      if (!didWork) await sleep(2000);
    } catch (err) {
      console.error("[worker] loop error:", (err as Error).message);
      await sleep(5000);
    }
  }
  await db.stop?.();
}

main().catch((err) => {
  console.error("[worker] fatal:", err.message);
  process.exit(1);
});
