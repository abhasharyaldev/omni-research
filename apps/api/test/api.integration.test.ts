import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapDatabase, disconnectPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { buildServer } from "../src/server.js";

/**
 * API integration tests via fastify.inject (no network): auth, ownership
 * isolation, CSRF, input validation, SSRF rejection at the API boundary.
 */
let db: DatabaseBootstrapResult;
let app: FastifyInstance;
let cookieA = "";
let cookieB = "";
let projectId = "";

const stamp = Date.now();

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie ?? "");
  return raw.split(";")[0] ?? "";
}

beforeAll(async () => {
  process.env.OMNI_DEPLOYMENT_MODE = "hosted"; // these suites exercise hosted auth semantics
  db = await bootstrapDatabase({ migrate: true });
  app = await buildServer();

  const registerA = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { "x-omni-csrf": "1" },
    payload: { email: `alice-${stamp}@local.test`, password: "password-abcdef", displayName: "Alice" },
  });
  expect(registerA.statusCode).toBe(200);
  cookieA = sessionCookie(registerA);

  const registerB = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { "x-omni-csrf": "1" },
    payload: { email: `bob-${stamp}@local.test`, password: "password-abcdef", displayName: "Bob" },
  });
  cookieB = sessionCookie(registerB);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await disconnectPrisma();
  await db?.stop?.();
});

describe("auth & CSRF", () => {
  it("rejects mutating requests without the CSRF header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieA },
      payload: { title: "x", mode: "deep-research", prompt: "x", topics: ["x"] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("csrf");
  });

  it("rejects unauthenticated project access", async () => {
    const response = await app.inject({ method: "GET", url: "/api/projects" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects wrong credentials without leaking which field failed", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-omni-csrf": "1" },
      payload: { email: `alice-${stamp}@local.test`, password: "wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toBe("Email or password is incorrect");
  });
});

describe("projects & authorization isolation", () => {
  it("creates a project with validated input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: {
        title: "Alice research",
        mode: "deep-research",
        prompt: "Research something interesting.",
        topics: ["topic one"],
        startingUrls: ["https://example.com/article"],
      },
    });
    expect(response.statusCode).toBe(200);
    projectId = response.json().project.id;
    expect(projectId).toBeTruthy();
  });

  it("rejects invalid input with a typed validation error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: { title: "", mode: "not-a-mode", prompt: "", topics: [] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("validation-error");
    expect(body.requestId).toBeTruthy();
  });

  it("prevents user B from reading or mutating user A's project", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { cookie: cookieB },
    });
    expect(read.statusCode).toBe(404); // indistinguishable from missing

    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}`,
      headers: { cookie: cookieB, "x-omni-csrf": "1" },
    });
    expect(del.statusCode).toBe(404);

    const stillThere = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}`,
      headers: { cookie: cookieA },
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("rejects internal-network URLs when adding sources", async () => {
    for (const url of [
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://intranet.local/x",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/sources`,
        headers: { cookie: cookieA, "x-omni-csrf": "1" },
        payload: { url },
      });
      expect(response.statusCode, url).toBe(400);
      expect(response.json().code).toBe("unsafe-url");
    }
  });

  it("starts a research run and blocks a second concurrent run", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/research-runs`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const runId = first.json().run.id;

    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/research-runs`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: {},
    });
    expect(second.statusCode).toBe(409);

    // User B cannot see or cancel A's run.
    const readByB = await app.inject({ method: "GET", url: `/api/research-runs/${runId}`, headers: { cookie: cookieB } });
    expect(readByB.statusCode).toBe(404);
    const cancelByB = await app.inject({
      method: "POST",
      url: `/api/research-runs/${runId}/cancel`,
      headers: { cookie: cookieB, "x-omni-csrf": "1" },
    });
    expect(cancelByB.statusCode).toBe(404);

    // Owner cancels the queued run cleanly.
    const cancel = await app.inject({
      method: "POST",
      url: `/api/research-runs/${runId}/cancel`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
    });
    expect(cancel.statusCode).toBe(200);
  });

  it("lists providers with the mock provider always available", async () => {
    const response = await app.inject({ method: "GET", url: "/api/providers", headers: { cookie: cookieA } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providers.map((p: any) => p.id)).toContain("mock");

    const check = await app.inject({
      method: "POST",
      url: "/api/providers/mock/check",
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().report.statusCode).toBe("ready");
  });
});
