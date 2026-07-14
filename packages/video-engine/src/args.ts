import { validateUrlSyntax } from "@omni/security";

/**
 * Pure, testable builder for the fixed watch.py argument template. No shell,
 * no string interpolation — a strict array of flags. Validates and clamps
 * every user-controllable value so nothing dangerous reaches the subprocess.
 */

export type VideoDetailMode = "transcript" | "efficient" | "balanced" | "token-burner";

export type VideoExtractOptions = {
  source: string; // URL or a server-side local file path (never a user-supplied disk path from the browser)
  outDir: string; // isolated temp dir created by the caller
  detailMode?: VideoDetailMode;
  maxFrames?: number;
  resolution?: number;
  fps?: number;
  startSec?: number;
  endSec?: number;
  noWhisper?: boolean;
  allowLocalFile?: boolean; // only the server sets this for server-managed files
};

export const HARD_MAX_FRAMES = 100;
const MODE_FRAME_CAP: Record<VideoDetailMode, number> = {
  transcript: 0, // transcript-only: no frames downloaded/extracted
  efficient: 24,
  balanced: 60,
  "token-burner": 100,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(value), max));
}

export function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Build the safe argument array for watch.py. Throws with a clear reason on
 * an unsafe source; the returned array is passed verbatim to spawn(shell:false).
 */
export function buildWatchArgs(scriptPath: string, options: VideoExtractOptions): { python: string; args: string[]; maxFrames: number; framesRequested: boolean } {
  const mode = options.detailMode ?? "transcript";

  if (isHttpUrl(options.source)) {
    // SSRF policy applies to every URL (blocks private/loopback/metadata hosts).
    const check = validateUrlSyntax(options.source);
    if (!check.ok) throw new Error(`Video URL blocked by safety policy: ${check.reason}`);
  } else {
    if (!options.allowLocalFile) throw new Error("Only http(s) video URLs are accepted from the browser; local files are handled server-side");
    // A server-managed path: reject traversal / suspicious characters defensively.
    if (/[\r\n\0]/.test(options.source) || options.source.startsWith("-")) throw new Error("Invalid local video path");
  }

  const frameCap = MODE_FRAME_CAP[mode];
  const maxFrames = options.maxFrames !== undefined ? clamp(options.maxFrames, 0, Math.min(frameCap || HARD_MAX_FRAMES, HARD_MAX_FRAMES)) : frameCap;
  const framesRequested = maxFrames > 0;

  // "--" is NOT used; the source is a positional. Guard against it being
  // interpreted as a flag by rejecting leading dashes above.
  const args: string[] = [options.source, "--out-dir", options.outDir];
  if (framesRequested) {
    args.push("--max-frames", String(maxFrames));
    args.push("--resolution", String(clamp(options.resolution ?? 512, 128, 1280)));
    if (options.fps !== undefined) args.push("--fps", String(Math.max(0.05, Math.min(options.fps, 10)).toFixed(3)));
  } else {
    // transcript-only: request the minimum frames the tool allows, we ignore them.
    args.push("--max-frames", "1");
  }
  if (options.startSec !== undefined) {
    if (options.startSec < 0) throw new Error("--start must be non-negative");
    args.push("--start", secToClock(options.startSec));
  }
  if (options.endSec !== undefined) {
    if (options.startSec !== undefined && options.endSec <= options.startSec) throw new Error("--end must be greater than --start");
    args.push("--end", secToClock(options.endSec));
  }
  // No-key by default: never let Whisper reach a remote API silently. The
  // upstream tool only uses remote Whisper when a key is present; we pass
  // --no-whisper unless the caller explicitly enabled a LOCAL whisper path.
  if (options.noWhisper !== false) args.push("--no-whisper");

  return { python: process.env.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3"), args, maxFrames, framesRequested };
}

export function secToClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
