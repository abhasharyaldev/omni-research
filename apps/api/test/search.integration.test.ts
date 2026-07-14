import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapDatabase, disconnectPrisma, getPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { newId } from "@omni/shared";
import { buildServer } from "../src/server.js";

/**
 * Cross-project search integration tests: PostgreSQL FTS over the generated
 * tsvector columns, owner scoping, type filters, snippets.
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
  const prisma = getPrisma();

  const registerA = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { "x-omni-csrf": "1" },
    payload: { email: `search-a-${stamp}@local.test`, password: "password-abcdef", displayName: "Searcher A" },
  });
  cookieA = sessionCookie(registerA);
  const userAId = registerA.json().user.id;

  const registerB = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { "x-omni-csrf": "1" },
    payload: { email: `search-b-${stamp}@local.test`, password: "password-abcdef", displayName: "Searcher B" },
  });
  cookieB = sessionCookie(registerB);

  // Seed searchable content directly: project + source + evidence + report.
  const project = await prisma.project.create({
    data: {
      id: newId("prj"),
      ownerId: userAId,
      title: `Zymurgy research ${stamp}`,
      mode: "deep-research",
      prompt: "Research zymurgy and fermentation science for brewing.",
    },
  });
  projectId = project.id;
  const source = await prisma.source.create({
    data: {
      id: newId("src"),
      projectId,
      url: "https://fixture.example/zymurgy",
      normalizedUrl: `https://fixture.example/zymurgy-${stamp}`,
      title: "Zymurgy fundamentals",
      excerpt: "Zymurgy is the study of fermentation in brewing and winemaking.",
      qualityScore: 72,
      classification: "educational-reference",
    },
  });
  const run = await prisma.researchRun.create({
    data: { id: newId("run"), projectId, status: "completed" },
  });
  await prisma.evidence.create({
    data: {
      id: newId("evd"),
      projectId,
      runId: run.id,
      sourceId: source.id,
      claim: "Zymurgy studies fermentation processes",
      evidenceText: "Zymurgy is the study of fermentation in brewing and winemaking.",
    },
  });
  const report = await prisma.report.create({
    data: { id: newId("rep"), projectId, runId: run.id, title: "Zymurgy report" },
  });
  await prisma.reportSection.create({
    data: {
      id: newId("sec"),
      reportId: report.id,
      title: "Findings on zymurgy",
      contentMd: "The collected sources agree that zymurgy underpins modern brewing science.[1]",
      order: 0,
    },
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  await disconnectPrisma();
  await db?.stop?.();
});

describe("GET /api/search", () => {
  it("requires authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/search?q=zymurgy" });
    expect(response.statusCode).toBe(401);
  });

  it("finds evidence, sources, report sections, and projects with snippets", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=zymurgy",
      headers: { cookie: cookieA },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const types = new Set(body.hits.map((h: any) => h.type));
    expect(types).toContain("evidence");
    expect(types).toContain("source");
    expect(types).toContain("report");
    expect(types).toContain("project");
    const evidenceHit = body.hits.find((h: any) => h.type === "evidence");
    expect(evidenceHit.snippet).toContain("[[");
    expect(evidenceHit.projectId).toBe(projectId);
    expect(evidenceHit.extra.qualityScore).toBe(72);
  });

  it("respects type filters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=zymurgy&types=source",
      headers: { cookie: cookieA },
    });
    const body = response.json();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.every((h: any) => h.type === "source")).toBe(true);
  });

  it("respects the minQuality filter", async () => {
    const filteredOut = await app.inject({
      method: "GET",
      url: "/api/search?q=zymurgy&types=source,evidence&minQuality=90",
      headers: { cookie: cookieA },
    });
    expect(filteredOut.json().hits).toHaveLength(0);
    const kept = await app.inject({
      method: "GET",
      url: "/api/search?q=zymurgy&types=source&minQuality=50",
      headers: { cookie: cookieA },
    });
    expect(kept.json().hits.length).toBeGreaterThan(0);
  });

  it("never returns another user's content", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=zymurgy",
      headers: { cookie: cookieB },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().hits).toHaveLength(0);
  });

  it("rejects too-short queries with a validation error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/search?q=z",
      headers: { cookie: cookieA },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation-error");
  });
});
