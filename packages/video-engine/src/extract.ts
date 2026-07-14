import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "@omni/shared";
import { detectVideoEngine } from "./detection.js";
import { buildWatchArgs, type VideoExtractOptions } from "./args.js";

/**
 * Deterministic media extraction (Stage A). Runs the pinned watch.py in a
 * hardened subprocess (no shell, fixed args, isolated temp dir, timeout,
 * process-tree kill, filtered env) and parses its markdown output into NEUTRAL
 * artifacts: timestamped transcript segments + frame file paths. AI analysis
 * (Stage B) is entirely separate — see analysis.ts.
 */

export type ExtractedSegment = { index: number; startMs: number; endMs: number; speaker?: string; text: string };
export type ExtractionResult = {
  segments: ExtractedSegment[];
  framePaths: string[];
  transcriptSource: string; // captions | whisper (...) | frames-only | none
  durationSec: number | null;
  warnings: string[];
  dataLeftDevice: boolean;
};

const ALLOWED_PYTHON = new Set(["python", "python3", "python.exe", "python3.exe"]);
const TIMEOUT_MS = Number(process.env.VIDEO_EXTRACT_TIMEOUT_MS || 300_000);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Minimal, safe environment for the child process (no secrets forwarded). */
function childEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PYTHONHOME", "PYTHONPATH", "YT_DLP_PATH", "FFMPEG_PATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key]) env[key] = process.env[key];
  // Explicitly ensure NO API keys reach the tool → no silent remote Whisper.
  return env;
}

function clockToMs(raw: string): number {
  const m = raw.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!m) return 0;
  const [, h, mm, ss, ms] = m;
  return (Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + Number((ms ?? "0").padEnd(3, "0"));
}

/** Parse watch.py's markdown transcript lines like `[00:03:14] Speaker: text`. */
export function parseWatchTranscript(stdout: string): { segments: ExtractedSegment[]; source: string } {
  const segments: ExtractedSegment[] = [];
  let source = "none";
  const srcMatch = stdout.match(/transcript source:\s*([^\n]+)/i) ?? stdout.match(/\((captions|whisper[^)]*)\)/i);
  if (srcMatch) source = srcMatch[1]!.trim();
  const lineRe = /^\s*\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)(?:\s*[-–—>]+\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))?\]\s*(?:([^:]{1,40}):\s)?(.+)$/;
  let index = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const startMs = clockToMs(m[1]!);
    const endMs = m[2] ? clockToMs(m[2]) : startMs;
    segments.push({ index: index++, startMs, endMs, speaker: m[3]?.trim() || undefined, text: m[4]!.trim() });
  }
  return { segments, source };
}

export async function runVideoExtraction(options: VideoExtractOptions & { signal?: AbortSignal }): Promise<ExtractionResult> {
  const status = detectVideoEngine();
  if (!status.available || !status.watchScript) {
    throw new Error(status.reason);
  }
  const workRoot = await mkdtemp(path.join(os.tmpdir(), "omni-video-"));
  try {
    const { python, args } = buildWatchArgs(status.watchScript, { ...options, outDir: workRoot });
    if (!ALLOWED_PYTHON.has(path.basename(python).toLowerCase())) throw new Error("Python interpreter is not on the allowlist");

    // Prepend the script path as the first arg (positional program for python).
    const fullArgs = [status.watchScript, ...args];
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(python, fullArgs, { shell: false, cwd: workRoot, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const kill = () => {
        killed = true;
        if (child.pid) {
          if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
          else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const timer = setTimeout(kill, TIMEOUT_MS);
      options.signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); if (stdout.length > MAX_OUTPUT_BYTES) kill(); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8", 0, 4000); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) reject(new Error("Video extraction timed out or was cancelled"));
        else resolve({ stdout, stderr, code });
      });
    });
    if (result.code !== 0) throw new Error(`Video extraction failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`);

    const { segments, source } = parseWatchTranscript(result.stdout);
    let framePaths: string[] = [];
    try {
      const framesDir = path.join(workRoot, "frames");
      framePaths = (await readdir(framesDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
    } catch { /* no frames dir (transcript-only) */ }

    const durationMatch = result.stderr.match(/duration[^0-9]*([0-9.]+)\s*s/i);
    const warnings: string[] = [];
    if (segments.length === 0) warnings.push("No transcript segments were produced (no captions available and local Whisper not enabled).");
    if (options.detailMode && options.detailMode !== "transcript" && framePaths.length === 0) warnings.push("No frames were extracted.");

    return {
      segments,
      framePaths,
      transcriptSource: source,
      durationSec: durationMatch ? Number(durationMatch[1]) : null,
      warnings,
      dataLeftDevice: false, // local extraction; remote Whisper is never enabled silently
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function segmentChecksum(seg: ExtractedSegment): string {
  return sha256Hex(`${seg.startMs}|${seg.endMs}|${seg.speaker ?? ""}|${seg.text}`).slice(0, 16);
}
