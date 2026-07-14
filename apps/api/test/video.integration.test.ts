import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapDatabase, disconnectPrisma, type DatabaseBootstrapResult } from "@omni/database";
import { buildServer } from "../src/server.js";

/**
 * Provider-neutral video engine: the caption-first path (subtitle -> neutral
 * transcript segments -> capability-gated mock analysis) runs with NO binaries,
 * so it is fully deterministic in CI.
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
const asA = () => ({ cookie: cookieA, "x-omni-csrf": "1" });

beforeAll(async () => {
  process.env.OMNI_DEPLOYMENT_MODE = "hosted";
  process.env.AI_PROVIDER = "mock";
  db = await bootstrapDatabase({ migrate: true });
  app = await buildServer();
  const regA = await app.inject({ method: "POST", url: "/api/auth/register", headers: { "x-omni-csrf": "1" }, payload: { email: `vid-a-${stamp}@local.test`, password: "password-abcdef", displayName: "Vid A" } });
  cookieA = sessionCookie(regA);
  const regB = await app.inject({ method: "POST", url: "/api/auth/register", headers: { "x-omni-csrf": "1" }, payload: { email: `vid-b-${stamp}@local.test`, password: "password-abcdef", displayName: "Vid B" } });
  cookieB = sessionCookie(regB);
  const create = await app.inject({ method: "POST", url: "/api/projects", headers: asA(), payload: { title: `Video ${stamp}`, mode: "deep-research", prompt: "video test", topics: ["t"] } });
  projectId = create.json().project.id;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await disconnectPrisma();
  await db?.stop?.();
  delete process.env.OMNI_DEPLOYMENT_MODE;
});

const SRT = `1
00:00:01,000 --> 00:00:04,000
Alice: Spaced repetition improves long-term retention.

2
00:00:05,000 --> 00:00:08,500
It works by expanding review intervals over time.`;

describe("video engine — caption-first path", () => {
  let videoId = "";

  it("reports honest engine status with a pinned commit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/video/status", headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.pin).toMatch(/^[a-f0-9]{40}$/);
    expect(res.json().status.captionImportAlways).toBe(true);
  });

  it("creates neutral transcript segments from an SRT (no binaries)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/videos/from-subtitle`, headers: asA(), payload: { content: SRT, format: "srt", title: "Lecture" } });
    expect(res.statusCode).toBe(200);
    videoId = res.json().video.id;
    expect(res.json().segmentCount).toBe(2);

    const full = (await app.inject({ method: "GET", url: `/api/videos/${videoId}`, headers: { cookie: cookieA } })).json().video;
    expect(full.status).toBe("ready");
    expect(full.captionSource).toBe("subtitle-import");
    expect(full.segments[0].speaker).toBe("Alice");
    expect(full.segments[0].startMs).toBe(1000); // exact timestamp preserved
    expect(full.segments[0].text).toContain("Spaced repetition");
  });

  it("analyzes the transcript with the mock provider (transcript-only, honest scope)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/videos/${videoId}/analyze`, headers: asA(), payload: { task: "summary", wantFrames: true } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Mock is text-only: frames requested but NOT used; scope note must say so.
    expect(body.mode).toBe("transcript-only");
    expect(body.scopeNote).toMatch(/never claim to have watched|TEXT-ONLY/i);
    expect(body.provider).toBe("mock");
    expect(typeof body.analysis).toBe("string");
  });

  it("rejects a non-http video URL", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/videos/from-url`, headers: asA(), payload: { url: "ftp://x/v.mp4" } });
    expect([400, 422]).toContain(res.statusCode);
  });

  it("returns a clear degraded error (or extracts) for a URL depending on tooling", async () => {
    const status = (await app.inject({ method: "GET", url: "/api/video/status", headers: { cookie: cookieA } })).json().status;
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/videos/from-url`, headers: asA(), payload: { url: "https://example.com/does-not-exist.mp4", detailMode: "transcript" } });
    if (!status.available) {
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("engine-unavailable");
    } else {
      // Tooling present but this URL is not a real video → extraction-failed, never fabricated.
      expect([422, 200]).toContain(res.statusCode);
    }
  });

  it("enforces ownership on videos", async () => {
    const res = await app.inject({ method: "GET", url: `/api/videos/${videoId}`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
    const analyze = await app.inject({ method: "POST", url: `/api/videos/${videoId}/analyze`, headers: { cookie: cookieB, "x-omni-csrf": "1" }, payload: { task: "summary" } });
    expect(analyze.statusCode).toBe(404);
  });
});
