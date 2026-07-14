import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapDatabase, disconnectPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { buildServer } from "../src/server.js";
import { assertLocalBindSafety, resetLocalIdentityCache } from "../src/local-identity.js";

/**
 * Account-free local mode (OMNI_DEPLOYMENT_MODE=local, the default):
 * every cookie-less request resolves to ONE stable server-side identity;
 * account endpoints are disabled; non-loopback binding fails closed.
 */
let db: DatabaseBootstrapResult;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.OMNI_DEPLOYMENT_MODE = "local";
  process.env.AI_PROVIDER = "mock";
  resetLocalIdentityCache();
  db = await bootstrapDatabase({ migrate: true });
  app = await buildServer();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await disconnectPrisma();
  await db?.stop?.();
  delete process.env.OMNI_DEPLOYMENT_MODE;
});

describe("account-free local mode", () => {
  it("serves the workspace without any session cookie", async () => {
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json().mode).toBe("local");
    expect(me.json().user).toBeTruthy();

    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect(projects.statusCode).toBe(200);
  });

  it("resolves every request to the same stable owner (existing users preserved)", async () => {
    const first = (await app.inject({ method: "GET", url: "/api/auth/me" })).json().user;
    const create = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { "x-omni-csrf": "1" },
      payload: { title: `Local mode ${Date.now()}`, mode: "deep-research", prompt: "local test", topics: ["t"] },
    });
    expect(create.statusCode).toBe(200);
    const second = (await app.inject({ method: "GET", url: "/api/auth/me" })).json().user;
    expect(second.id).toBe(first.id);

    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json().projects.some((p: any) => p.id === create.json().project.id)).toBe(true);
  });

  it("still enforces the CSRF header on mutations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "no csrf", mode: "deep-research", prompt: "x", topics: ["t"] },
    });
    expect(response.statusCode).toBe(403);
  });

  it("disables account registration and login", async () => {
    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { "x-omni-csrf": "1" },
      payload: { email: "someone@x.test", password: "password-abcdef", displayName: "X" },
    });
    expect(register.statusCode).toBe(409);
    expect(register.json().code).toBe("local-mode");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-omni-csrf": "1" },
      payload: { email: "someone@x.test", password: "password-abcdef" },
    });
    expect(login.statusCode).toBe(409);
  });

  it("fails closed when local mode would bind beyond loopback", () => {
    expect(() => assertLocalBindSafety("127.0.0.1")).not.toThrow();
    expect(() => assertLocalBindSafety("0.0.0.0")).toThrow(/refusing to listen/);
    expect(() => assertLocalBindSafety("192.168.1.10")).toThrow(/refusing to listen/);
  });

  it("double-confirm on an import is atomic: one success, retry is idempotent", async () => {
    const projectId = (await app.inject({ method: "GET", url: "/api/projects" })).json().projects[0].id;
    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/imports`,
      headers: { "x-omni-csrf": "1" },
      payload: { content: `atomic confirm test payload ${Date.now()} with enough words to import` },
    });
    const jobId = preview.json().jobId;

    // Fire two confirmations concurrently: exactly one claims the job.
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/api/imports/${jobId}/confirm`, headers: { "x-omni-csrf": "1" } }),
      app.inject({ method: "POST", url: `/api/imports/${jobId}/confirm`, headers: { "x-omni-csrf": "1" } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([200, 409]).toContain(codes[1]); // loser: claimed-conflict, or idempotent replay if it arrived after completion
    const winner = a.statusCode === 200 ? a : b;
    expect(winner.json().counts.imported).toBe(1);

    // A later retry is idempotent and returns the persisted summary.
    const retry = await app.inject({ method: "POST", url: `/api/imports/${jobId}/confirm`, headers: { "x-omni-csrf": "1" } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().counts.imported).toBe(1);
    expect(retry.json().counts.idempotent).toBe(true);
  });
});
