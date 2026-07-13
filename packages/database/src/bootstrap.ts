import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * Local-first database bootstrap.
 *
 * Order of preference:
 *  1. The PostgreSQL at DATABASE_URL (e.g. docker compose).
 *  2. When unreachable and USE_EMBEDDED_DB=true (default in development), an
 *     embedded PostgreSQL under .local-data/postgres — no Docker required.
 *
 * Never invents success: when neither is available, it throws with clear
 * instructions.
 */

export const EMBEDDED_DB_PORT = 5498;

export type DatabaseBootstrapResult = {
  databaseUrl: string;
  mode: "external" | "embedded";
  stop?: () => Promise<void>;
};

function repoRoot(): string {
  // packages/database/src -> repo root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function portReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function urlReachable(databaseUrl: string): Promise<boolean> {
  try {
    const url = new URL(databaseUrl);
    return await portReachable(url.hostname, Number(url.port || 5432));
  } catch {
    return false;
  }
}

let embeddedInstance: { stop: () => Promise<void> } | null = null;

async function startEmbedded(): Promise<string> {
  const dataDir = path.join(repoRoot(), ".local-data", "postgres");
  await mkdir(dataDir, { recursive: true });
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: EMBEDDED_DB_PORT,
    persistent: true,
    // UTF8 always: Windows initdb otherwise defaults to the system codepage
    // (e.g. WIN1252), which cannot store non-Latin research text (Devanagari,
    // CJK, arrows, …). locale=C keeps initdb deterministic across machines.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  const alreadyInitialized = existsSync(path.join(dataDir, "PG_VERSION"));
  if (!alreadyInitialized) {
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient();
  try {
    await client.connect();
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = 'omniresearch'");
    if (existing.rowCount === 0) {
      await client.query("CREATE DATABASE omniresearch");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  embeddedInstance = pg;
  return `postgresql://postgres:postgres@127.0.0.1:${EMBEDDED_DB_PORT}/omniresearch`;
}

/** Run `prisma migrate deploy` against the resolved database URL. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const root = repoRoot();
  // Invoke the Prisma CLI's JS entry with the current Node binary: spawning
  // .CMD shims without a shell throws EINVAL on Windows (Node >= 18.20).
  const require = createRequire(path.join(root, "package.json"));
  const prismaJs = require.resolve("prisma/build/index.js");
  const schema = path.join(root, "prisma", "schema.prisma");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [prismaJs, "migrate", "deploy", "--schema", schema], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy failed (exit ${code}):\n${output.slice(-2000)}`));
    });
  });
}

export async function bootstrapDatabase(options: { migrate?: boolean } = {}): Promise<DatabaseBootstrapResult> {
  const configured = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/omniresearch";
  const useEmbedded = (process.env.USE_EMBEDDED_DB ?? "true").toLowerCase() !== "false";

  if (await urlReachable(configured)) {
    if (options.migrate) await runMigrations(configured);
    return { databaseUrl: configured, mode: "external" };
  }

  const embeddedUrl = `postgresql://postgres:postgres@127.0.0.1:${EMBEDDED_DB_PORT}/omniresearch`;
  if (useEmbedded) {
    // Another local process may already be running the embedded server.
    if (await portReachable("127.0.0.1", EMBEDDED_DB_PORT)) {
      process.env.DATABASE_URL = embeddedUrl;
      if (options.migrate) await runMigrations(embeddedUrl);
      return { databaseUrl: embeddedUrl, mode: "embedded" };
    }
    try {
      const url = await startEmbedded();
      process.env.DATABASE_URL = url;
      if (options.migrate) await runMigrations(url);
      return {
        databaseUrl: url,
        mode: "embedded",
        stop: async () => {
          await embeddedInstance?.stop();
          embeddedInstance = null;
        },
      };
    } catch (err) {
      // Another process may have won the race to start the embedded server.
      if (await portReachable("127.0.0.1", EMBEDDED_DB_PORT, 3000)) {
        process.env.DATABASE_URL = embeddedUrl;
        if (options.migrate) await runMigrations(embeddedUrl);
        return { databaseUrl: embeddedUrl, mode: "embedded" };
      }
      throw new Error(
        `PostgreSQL at ${configured} is unreachable and the embedded fallback failed to start: ${(err as Error).message}\n` +
          `Fix: start PostgreSQL with "docker compose up -d" or install PostgreSQL locally and set DATABASE_URL.`
      );
    }
  }

  throw new Error(
    `PostgreSQL at ${configured} is unreachable and USE_EMBEDDED_DB=false.\n` +
      `Fix: start PostgreSQL with "docker compose up -d", or set USE_EMBEDDED_DB=true for the embedded fallback.`
  );
}
