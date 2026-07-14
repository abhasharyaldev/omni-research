import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma, recordTimelineEvent } from "@omni/database";
import { newId, sha256Hex } from "@omni/shared";
import { getProviderManager, ProviderError } from "@omni/ai-providers";
import {
  detectVideoEngine,
  isHttpUrl,
  planVideoAnalysis,
  analysisInstructions,
  runVideoExtraction,
  segmentChecksum,
  type VideoAnalysisTask,
} from "@omni/video-engine";
import { parseSubtitles } from "../services/import-formats.js";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

const ANALYSIS_TASKS: VideoAnalysisTask[] = ["summary", "claim-extraction", "chapter-outline", "key-quotes", "topic-list"];

async function requireVideo(id: string, userId: string) {
  const prisma = getPrisma();
  const video = await prisma.videoAsset.findUnique({ where: { id }, include: { project: true } });
  if (!video || video.project.ownerId !== userId) throw new ApiHttpError(404, "not-found", "Video not found");
  return video;
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  /** Honest engine status: what is installed, the pinned commit, degraded-mode reasons. */
  app.get("/api/video/status", async (request) => {
    requireUser(request);
    const status = detectVideoEngine();
    return { status };
  });

  app.get("/api/projects/:id/videos", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const videos = await prisma.videoAsset.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { segments: true } } },
      take: 50,
    });
    return { videos };
  });

  app.get("/api/videos/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireVideo(id, user.id);
    const video = await prisma.videoAsset.findUnique({
      where: { id },
      include: { segments: { orderBy: { index: "asc" } } },
    });
    return { video };
  });

  /**
   * Create a video asset from a SUBTITLE file (caption-first, no binaries) —
   * the always-available path. Produces neutral transcript segments.
   */
  app.post("/api/projects/:id/videos/from-subtitle", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const body = z
      .object({
        content: z.string().min(1).max(3_000_000),
        format: z.enum(["srt", "vtt"]),
        title: z.string().max(300).optional(),
      })
      .parse(request.body ?? {});
    const parsed = parseSubtitles(body.content, body.format);
    if (parsed.cues.length === 0) throw new ApiHttpError(400, "no-cues", "No subtitle cues could be parsed");

    const video = await prisma.videoAsset.create({
      data: {
        id: newId("vid"),
        projectId: id,
        sourceKind: "subtitle-import",
        sourceRef: body.title ?? `subtitles.${body.format}`,
        title: body.title ?? `Transcript (${body.format.toUpperCase()})`,
        captionSource: "subtitle-import",
        language: parsed.language,
        detailMode: "transcript",
        status: "ready",
        engineVersion: null,
        enginePin: null,
        dataLeftDevice: false,
        warnings: parsed.warnings.slice(0, 20),
        checksum: sha256Hex(body.content).slice(0, 32),
      },
    });
    await prisma.transcriptSegment.createMany({
      data: parsed.cues.map((c, index) => ({
        id: newId("seg"),
        videoAssetId: video.id,
        index,
        startMs: c.startMs,
        endMs: c.endMs,
        speaker: c.speaker,
        text: c.text,
        checksum: sha256Hex(`${c.startMs}|${c.text}`).slice(0, 16),
      })),
    });
    await recordTimelineEvent(prisma, { projectId: id, type: "import-completed", summary: `Video transcript imported from ${body.format.toUpperCase()} (${parsed.cues.length} segments)`, entityType: "import", entityId: video.id });
    await audit(user.id, "video.from-subtitle", "video", video.id, request, { cues: parsed.cues.length });
    return { video, segmentCount: parsed.cues.length };
  });

  /**
   * Create + extract a video asset from a URL using the pinned tooling. Degrades
   * with a clear error when the engine is unavailable (never fabricates output).
   */
  app.post("/api/projects/:id/videos/from-url", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const body = z
      .object({
        url: z.string().url().max(2000),
        detailMode: z.enum(["transcript", "efficient", "balanced", "token-burner"]).default("transcript"),
        maxFrames: z.number().int().min(0).max(100).optional(),
        startSec: z.number().min(0).optional(),
        endSec: z.number().min(0).optional(),
        title: z.string().max(300).optional(),
      })
      .parse(request.body ?? {});
    if (!isHttpUrl(body.url)) throw new ApiHttpError(400, "invalid-url", "Only http(s) video URLs are accepted");
    const status = detectVideoEngine();
    if (!status.available) throw new ApiHttpError(422, "engine-unavailable", status.reason);

    const video = await prisma.videoAsset.create({
      data: {
        id: newId("vid"),
        projectId: id,
        sourceKind: "url",
        sourceRef: body.url,
        title: body.title ?? body.url,
        detailMode: body.detailMode,
        status: "extracting",
        engineVersion: status.version,
        enginePin: status.pin,
      },
    });

    try {
      const result = await runVideoExtraction({
        source: body.url,
        outDir: "", // set inside the runner
        detailMode: body.detailMode,
        maxFrames: body.maxFrames,
        startSec: body.startSec,
        endSec: body.endSec,
      });
      await prisma.transcriptSegment.createMany({
        data: result.segments.map((s) => ({
          id: newId("seg"),
          videoAssetId: video.id,
          index: s.index,
          startMs: s.startMs,
          endMs: s.endMs,
          speaker: s.speaker,
          text: s.text,
          checksum: segmentChecksum(s),
        })),
      });
      const updated = await prisma.videoAsset.update({
        where: { id: video.id },
        data: {
          status: "ready",
          captionSource: result.transcriptSource.startsWith("whisper") ? "whisper" : result.transcriptSource === "captions" ? "auto" : result.segments.length ? "auto" : "frames-only",
          durationSec: result.durationSec,
          frameCount: result.framePaths.length,
          warnings: result.warnings.slice(0, 20),
          dataLeftDevice: result.dataLeftDevice,
        },
      });
      await recordTimelineEvent(prisma, { projectId: id, type: "import-completed", summary: `Video extracted (${result.segments.length} segments, ${result.framePaths.length} frames)`, entityType: "import", entityId: video.id });
      await audit(user.id, "video.from-url", "video", video.id, request, { segments: result.segments.length });
      return { video: updated, segmentCount: result.segments.length, frameCount: result.framePaths.length };
    } catch (err) {
      await prisma.videoAsset.update({ where: { id: video.id }, data: { status: "failed", error: String((err as Error).message).slice(0, 900) } });
      throw new ApiHttpError(422, "extraction-failed", (err as Error).message);
    }
  });

  /**
   * Provider-neutral, capability-gated analysis of a video's neutral artifacts.
   * A text-only provider is never told it saw frames; frames are included ONLY
   * when the chosen provider declares image input.
   */
  app.post("/api/videos/:id/analyze", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const video = await requireVideo(id, user.id);
    const body = z
      .object({
        task: z.enum(ANALYSIS_TASKS as unknown as [string, ...string[]]).default("summary"),
        provider: z.string().max(40).optional(),
        wantFrames: z.boolean().default(false),
      })
      .parse(request.body ?? {});

    const segments = await prisma.videoAsset.findUniqueOrThrow({ where: { id }, include: { segments: { orderBy: { index: "asc" } } } }).then((v) => v.segments);
    const providers = getProviderManager();
    const providerId = (body.provider ?? video.project.provider ?? providers.defaultId()) as never;
    const provider = providers.get(providerId);
    const capabilities = await provider.getCapabilities();

    const planned = planVideoAnalysis({
      segments: segments.map((s) => ({ index: s.index, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker ?? undefined, text: s.text })),
      framePaths: [], // frame BYTES are not persisted in this slice; wantFrames is honestly gated to false-effect
      wantFrames: body.wantFrames,
      capabilities: { textGeneration: capabilities.textGeneration, imageInput: capabilities.imageInput },
    });
    if ("blocked" in planned) throw new ApiHttpError(422, "capability-missing", planned.blocked);
    const plan = planned.plan;

    const instructions = analysisInstructions(body.task as VideoAnalysisTask, plan);
    try {
      const result = await provider.generateText({
        requestId: `video-${id}-${body.task}-${Date.now()}`,
        taskKind: "generic",
        instructions,
        data: plan.transcriptBlock,
        context: { task: body.task, videoTitle: video.title, segmentCount: segments.length },
      });
      await audit(user.id, "video.analyze", "video", id, request, { task: body.task, provider: providerId, mode: plan.mode });
      return {
        analysis: result.text,
        mode: plan.mode,
        scopeNote: plan.scopeNote,
        provider: providerId,
        model: result.model,
        segmentCount: segments.length,
        dataLeftDevice: capabilities.localOnly === false,
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        throw new ApiHttpError(422, "provider-failed", `Provider "${providerId}" failed (${err.code}): ${err.message}. Try another provider or transcript-only mode.`);
      }
      throw err;
    }
  });

  app.delete("/api/videos/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireVideo(id, user.id);
    await prisma.videoAsset.delete({ where: { id } });
    return { ok: true };
  });
}
