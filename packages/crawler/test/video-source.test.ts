import { describe, expect, it } from "vitest";
import type { ResearchRequestData } from "@omni/shared";
import type { ExtractionResult } from "@omni/video-engine";
import { extractVideoSource, isVideoUrl, transcriptToText, type VideoExtractor } from "../src/video-source.js";
import type { CrawlTask } from "../src/crawler-types.js";

const userData: ResearchRequestData = {
  projectId: "p",
  researchRunId: "r",
  topicId: "t",
  depth: 0,
  priority: 0,
  discoveredBy: "user",
};
const task = (url: string): CrawlTask => ({ url, userData });

function extraction(segments: ExtractionResult["segments"]): ExtractionResult {
  return { segments, framePaths: [], transcriptSource: segments.length ? "captions" : "none", durationSec: null, warnings: [], dataLeftDevice: false };
}
const fakeMeta = async () => ({ title: "My Video", uploader: "Some Channel", webpageUrl: "https://youtube.com/watch?v=abc" });

describe("isVideoUrl", () => {
  it("matches video platforms and their variants", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://youtube.com/shorts/abc",
      "https://www.youtube.com/live/abc",
      "https://m.youtube.com/watch?v=abc",
      "https://music.youtube.com/watch?v=abc",
      "https://vimeo.com/12345",
      "https://www.tiktok.com/@u/video/1",
      "https://www.twitch.tv/somestream",
    ]) {
      expect(isVideoUrl(url), url).toBe(true);
    }
  });

  it("rejects non-video and malformed URLs", () => {
    for (const url of ["https://example.com/article", "https://news.site/watch/story", "https://notyoutube.com/x", "not a url"]) {
      expect(isVideoUrl(url), url).toBe(false);
    }
  });
});

describe("transcriptToText", () => {
  it("formats each segment as a citable [hh:mm:ss] line", () => {
    const text = transcriptToText([
      { index: 0, startMs: 0, endMs: 2000, text: "Intro sentence" },
      { index: 1, startMs: 65_000, endMs: 68_000, speaker: "Host", text: "Later point" },
    ]);
    expect(text).toBe("[00:00:00] Intro sentence\n[00:01:05] Host: Later point");
  });
});

describe("extractVideoSource", () => {
  it("converts captions into a video RetrievedPage with timestamped text + metadata", async () => {
    const extractor: VideoExtractor = async () =>
      extraction([
        { index: 0, startMs: 0, endMs: 3000, text: "Neuroplasticity is real" },
        { index: 1, startMs: 194_000, endMs: 197_000, text: "Sleep consolidates memory" },
      ]);
    const result = await extractVideoSource(task("https://youtube.com/watch?v=abc"), {}, extractor, fakeMeta);
    expect("retrieved" in result).toBe(true);
    if (!("retrieved" in result)) throw new Error("expected retrieved");
    const page = result.retrieved;
    expect(page.crawlMethod).toBe("video");
    expect(page.metadata.title).toBe("My Video");
    expect(page.metadata.author).toBe("Some Channel");
    expect(page.mainText).toContain("[00:00:00] Neuroplasticity is real");
    expect(page.mainText).toContain("[00:03:14] Sleep consolidates memory");
    expect(page.wordCount).toBeGreaterThan(3);
    expect(page.contentHash).toMatch(/^[0-9a-f]+$/);
  });

  it("skips (never fails) when a video has no captions", async () => {
    const extractor: VideoExtractor = async () => extraction([]);
    const result = await extractVideoSource(task("https://youtu.be/nocaps"), {}, extractor, fakeMeta);
    expect("skipped" in result).toBe(true);
    if (!("skipped" in result)) throw new Error("expected skipped");
    expect(result.skipped.reason).toBe("no-transcript");
    expect(result.skipped.detail).toContain("no transcript available");
  });

  it("reports a failure when extraction throws", async () => {
    const extractor: VideoExtractor = async () => {
      throw new Error("yt-dlp exploded");
    };
    const result = await extractVideoSource(task("https://youtu.be/boom"), {}, extractor, fakeMeta);
    expect("failed" in result).toBe(true);
    if (!("failed" in result)) throw new Error("expected failed");
    expect(result.failed.error).toContain("yt-dlp exploded");
  });
});
