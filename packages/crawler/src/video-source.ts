import { sha256Hex } from "@omni/shared";
import { validateUrlSyntax, type UrlPolicy } from "@omni/security";
import {
  fetchCaptions,
  fetchVideoMetadata,
  type ExtractedSegment,
  type ExtractionResult,
  type VideoMetadata,
} from "@omni/video-engine";
import type { CrawlTask, FailedPage, RetrievedPage, SkippedPage } from "./crawler-types.js";

/**
 * Video-platform URLs are not crawlable as HTML — they are "watched" instead:
 * the transcript (captions) is extracted via @omni/video-engine and returned as
 * a normal RetrievedPage (crawlMethod: "video"), so the rest of the research
 * pipeline (dedup → classify → evidence → citations) consumes it unchanged.
 */

const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "dailymotion.com", "tiktok.com", "twitch.tv"];

/** Canonical detector shared by the crawler, preview, and pipeline. */
export function isVideoUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  // Covers youtube.com/watch, /shorts, /live, youtu.be, m./music.youtube.com, etc.
  return VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export type VideoExtractor = (input: {
  source: string;
  detailMode: "transcript";
  signal?: AbortSignal;
}) => Promise<ExtractionResult>;

// Captions-only (no video download) — fast and robust for research sourcing.
const defaultExtractor: VideoExtractor = (input) => fetchCaptions(input.source, input.signal);

export type VideoSourceOptions = { policy?: UrlPolicy; signal?: AbortSignal };

export type VideoSourceResult =
  | { retrieved: RetrievedPage }
  | { skipped: SkippedPage }
  | { failed: FailedPage };

function msToClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Timestamped, citable transcript body: one `[hh:mm:ss] text` line per segment. */
export function transcriptToText(segments: ExtractedSegment[]): string {
  return segments
    .map((seg) => `[${msToClock(seg.startMs)}] ${seg.speaker ? `${seg.speaker}: ` : ""}${seg.text}`.trim())
    .join("\n");
}

/**
 * Extract a video URL into a RetrievedPage. No captions → a `no-transcript`
 * skip (never a hard failure). `extractor` is injectable for tests.
 */
export type MetadataFetcher = (url: string, signal?: AbortSignal) => Promise<VideoMetadata>;

export async function extractVideoSource(
  task: CrawlTask,
  options: VideoSourceOptions = {},
  extractor: VideoExtractor = defaultExtractor,
  metadataFetcher: MetadataFetcher = fetchVideoMetadata
): Promise<VideoSourceResult> {
  const url = task.url;

  const safety = validateUrlSyntax(url, options.policy);
  if (!safety.ok) {
    const reason =
      safety.reason === "domain-blocked" || safety.reason === "not-in-allowlist"
        ? "domain-blocked"
        : safety.reason === "forbidden-ip" || safety.reason === "forbidden-hostname"
          ? "private-network"
          : "unsafe-url";
    return { skipped: { url, userData: task.userData, reason, detail: safety.detail } };
  }

  let result: ExtractionResult;
  try {
    result = await extractor({ source: url, detailMode: "transcript", signal: options.signal });
  } catch (err) {
    return { failed: { url, userData: task.userData, error: (err as Error).message.slice(0, 500), retries: 0 } };
  }

  if (result.segments.length === 0) {
    return {
      skipped: {
        url,
        userData: task.userData,
        reason: "no-transcript",
        detail: "no transcript available (no captions found; paste a transcript or use a captioned video)",
      },
    };
  }

  const metadata: VideoMetadata = await metadataFetcher(url, options.signal).catch(() => ({}));
  const mainText = transcriptToText(result.segments);
  const finalUrl = metadata.webpageUrl ?? url;

  const page: RetrievedPage = {
    requestedUrl: url,
    finalUrl,
    canonicalUrl: metadata.webpageUrl,
    userData: task.userData,
    status: 200,
    contentType: "video/transcript",
    crawlMethod: "video",
    retrievedAt: new Date(),
    metadata: {
      title: metadata.title ?? url,
      author: metadata.uploader,
      publisher: metadata.uploader,
      publishedAt: metadata.uploadDate,
      canonicalUrl: metadata.webpageUrl,
    },
    mainText,
    headings: [],
    wordCount: mainText.split(/\s+/).filter(Boolean).length,
    contentHash: sha256Hex(mainText.toLowerCase().replace(/\s+/g, " ").trim()),
    outboundLinks: [],
    paywallSuspected: false,
    loginSuspected: false,
  };
  return { retrieved: page };
}
