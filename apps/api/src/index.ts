import { bootstrapDatabase, cleanupExpiredSessions, getPrisma } from "@omni/database";
import { buildServer } from "./server.js";
import { assertLocalBindSafety } from "./local-identity.js";

async function main(): Promise<void> {
  if (!process.env.AUTH_SECRET && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set in production");
  }
  const db = await bootstrapDatabase({ migrate: true });
  console.log(`[api] database ready (${db.mode})`);

  const app = await buildServer();
  const port = Number(process.env.API_PORT || 4000);
  const host = process.env.API_HOST || "127.0.0.1";
  assertLocalBindSafety(host);
  await app.listen({ port, host });
  console.log(`[api] listening on http://127.0.0.1:${port}`);

  // Hourly session cleanup.
  setInterval(() => {
    cleanupExpiredSessions(getPrisma()).catch(() => undefined);
  }, 3_600_000).unref();

  const shutdown = async () => {
    await app.close();
    await db.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[api] fatal:", err.message);
  process.exit(1);
});
