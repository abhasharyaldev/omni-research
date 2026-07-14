import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapDatabase, disconnectPrisma, getPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { newId } from "@omni/shared";
import { buildServer } from "../src/server.js";

/**
 * Full storytelling workflow integration test with the MOCK provider (no
 * external calls): create story from verified research → blueprint → outline
 * → hooks → script → critique → validate; citation preservation, locked
 * facts, invocation records, and permission enforcement.
 */
let db: DatabaseBootstrapResult;
let app: FastifyInstance;
let cookieA = "";
let cookieB = "";
let projectId = "";
let storyId = "";

const stamp = Date.now();

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie ?? "");
  return raw.split(";")[0] ?? "";
}

beforeAll(async () => {
  process.env.OMNI_DEPLOYMENT_MODE = "hosted"; // these suites exercise hosted auth semantics
  process.env.AI_PROVIDER = "mock";
  db = await bootstrapDatabase({ migrate: true });
  app = await buildServer();
  const prisma = getPrisma();

  const registerA = await app.inject({
    method: "POST", url: "/api/auth/register", headers: { "x-omni-csrf": "1" },
    payload: { email: `story-a-${stamp}@local.test`, password: "password-abcdef", displayName: "Story A" },
  });
  cookieA = sessionCookie(registerA);
  const registerB = await app.inject({
    method: "POST", url: "/api/auth/register", headers: { "x-omni-csrf": "1" },
    payload: { email: `story-b-${stamp}@local.test`, password: "password-abcdef", displayName: "Story B" },
  });
  cookieB = sessionCookie(registerB);

  // Seed a project with verified evidence directly (the storytelling layer's input).
  const project = await prisma.project.create({
    data: {
      id: newId("prj"), ownerId: registerA.json().user.id, title: `Story test ${stamp}`,
      mode: "deep-research", prompt: "Research spaced repetition for a video.", provider: "mock",
    },
  });
  projectId = project.id;
  const source = await prisma.source.create({
    data: {
      id: newId("src"), projectId, url: "https://fixture.example/sr", normalizedUrl: `https://fixture.example/sr-${stamp}`,
      title: "Spaced repetition study", qualityScore: 70, classification: "educational-reference",
    },
  });
  const run = await prisma.researchRun.create({ data: { id: newId("run"), projectId, status: "completed" } });
  for (const [i, text] of [
    "Spaced repetition improves long-term retention compared to cramming",
    "Review intervals should grow after each successful recall",
    "Active retrieval strengthens memory more than passive re-reading",
  ].entries()) {
    await prisma.evidence.create({
      data: {
        id: newId("evd"), projectId, runId: run.id, sourceId: source.id,
        claim: text, evidenceText: `${text}.`, relevanceScore: 0.9 - i * 0.1, evidenceStrength: "strong",
      },
    });
  }
}, 300_000);

afterAll(async () => {
  await app?.close();
  await disconnectPrisma();
  await db?.stop?.();
});

describe("storytelling workflow", () => {
  it("reports skill availability honestly (status endpoint, no invocation)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/storytelling/status", headers: { cookie: cookieA } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(["claude-skill", "fallback"]).toContain(body.integration);
    expect(body.searchedPaths.length).toBe(2);
    if (body.integration === "claude-skill") {
      expect(body.storytelling.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("creates a story from verified research with an explained structure choice", async () => {
    const response = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/stories`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: { settings: { mode: "auto", platform: "youtube-long", targetDurationSec: 300 } },
    });
    expect(response.statusCode).toBe(200);
    const story = response.json().story;
    storyId = story.id;
    expect(story.resolvedMode).toBeTruthy();
    expect(story.frameworkReason.length).toBeGreaterThan(10);
    expect(story.packageVersion).toBeTruthy();
  });

  it("enforces workflow order: no script before a blueprint", async () => {
    const response = await app.inject({
      method: "POST", url: `/api/stories/${storyId}/generate/script`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("missing-blueprint");
  });

  it("generates blueprint → outline → hooks → script with preserved evidence refs", async () => {
    for (const stage of ["blueprint", "outline", "hooks", "script"]) {
      const response = await app.inject({
        method: "POST", url: `/api/stories/${storyId}/generate/${stage}`,
        headers: { cookie: cookieA, "x-omni-csrf": "1" },
      });
      expect(response.statusCode, stage).toBe(200);
      expect(response.json().invocation.method).toBeTruthy();
    }
    const story = (await app.inject({ method: "GET", url: `/api/stories/${storyId}`, headers: { cookie: cookieA } })).json().story;
    // Citation preservation: every factual script line carries package refs.
    const factLines = story.artifacts.script.lines.filter((l: any) => l.statement === "fact");
    expect(factLines.length).toBeGreaterThan(0);
    expect(factLines.every((l: any) => l.evidenceRefs.length > 0)).toBe(true);
    // Invocation records exist with method + package version.
    expect(story.invocations.length).toBeGreaterThanOrEqual(4);
    expect(story.invocations.every((i: any) => i.status === "success" && i.packageVersion)).toBe(true);
  });

  it("locks a fact and validates the script (mock output should pass)", async () => {
    const lock = await app.inject({
      method: "POST", url: `/api/stories/${storyId}/lock-fact`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: { evidenceRef: "E1" },
    });
    expect(lock.statusCode).toBe(200);

    const validate = await app.inject({
      method: "POST", url: `/api/stories/${storyId}/validate`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
    });
    expect(validate.statusCode).toBe(200);
    const result = validate.json().result;
    expect(result.verdict).toBe("ready");
    expect(result.supportedLines).toBeGreaterThan(0);

    const story = (await app.inject({ method: "GET", url: `/api/stories/${storyId}`, headers: { cookie: cookieA } })).json().story;
    expect(story.status).toBe("validated");
  });

  it("critiques the script", async () => {
    const response = await app.inject({
      method: "POST", url: `/api/stories/${storyId}/generate/critique`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().content.overallAssessment).toBeTruthy();
  });

  it("enforces ownership: user B cannot access or generate", async () => {
    const read = await app.inject({ method: "GET", url: `/api/stories/${storyId}`, headers: { cookie: cookieB } });
    expect(read.statusCode).toBe(404);
    const generate = await app.inject({
      method: "POST", url: `/api/stories/${storyId}/generate/script`,
      headers: { cookie: cookieB, "x-omni-csrf": "1" },
    });
    expect(generate.statusCode).toBe(404);
  });

  it("refuses to create a story for a project without evidence", async () => {
    const prisma = getPrisma();
    const empty = await prisma.project.create({
      data: { id: newId("prj"), ownerId: (await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).ownerId, title: "empty", mode: "deep-research", prompt: "x" },
    });
    const response = await app.inject({
      method: "POST", url: `/api/projects/${empty.id}/stories`,
      headers: { cookie: cookieA, "x-omni-csrf": "1" },
      payload: {},
    });
    expect(response.statusCode).toBe(500); // engine error surfaced (no silent fallback)
    expect(response.json().message).toContain("no verified evidence");
  });
});
