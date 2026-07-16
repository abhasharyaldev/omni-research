import { describe, expect, it, vi } from "vitest";

// Mock the extraction engine so the routing test stays offline (no yt-dlp).
vi.mock("@omni/video-engine", () => ({
  fetchCaptions: vi.fn(async () => ({
    segments: [{ index: 0, startMs: 0, endMs: 2000, text: "Mocked transcript line" }],
    framePaths: [],
    transcriptSource: "captions",
    durationSec: 10,
    warnings: [],
    dataLeftDevice: false,
  })),
  fetchVideoMetadata: vi.fn(async () => ({ title: "Mock Video", uploader: "Chan", webpageUrl: "https://youtube.com/watch?v=abc" })),
}));

import path from "node:path";
import { DEFAULT_CRAWL_LIMITS, type ResearchRequestData } from "@omni/shared";
import { crawlPages } from "../src/crawler-manager.js";

const userData: ResearchRequestData = {
  projectId: "p",
  researchRunId: "r",
  topicId: "t",
  depth: 0,
  priority: 0,
  discoveredBy: "user",
};

describe("crawlPages video routing", () => {
  it("routes YouTube URLs to transcript extraction, not the HTML crawler", async () => {
    const outcome = await crawlPages({
      tasks: [{ url: "https://www.youtube.com/watch?v=abc", userData }],
      limits: { ...DEFAULT_CRAWL_LIMITS, defaultDelayMs: 0 },
      policy: {},
      userAgent: "OmniResearchBot/1.0-test",
      storageDir: path.join(".local-data", "test-video-routing"),
      runId: `tv-${Date.now()}`,
    });

    expect(outcome.retrieved).toHaveLength(1);
    const page = outcome.retrieved[0]!;
    expect(page.crawlMethod).toBe("video");
    expect(page.mainText).toContain("[00:00:00] Mocked transcript line");
    expect(page.metadata.title).toBe("Mock Video");
    // Was never attempted as an HTTP/HTML fetch.
    expect(outcome.failed).toHaveLength(0);
  });
});
