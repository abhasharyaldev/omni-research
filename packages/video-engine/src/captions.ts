import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateUrlSyntax } from "@omni/security";
import { detectVideoEngine } from "./detection.js";
import type { ExtractedSegment, ExtractionResult } from "./extract.js";

/**
 * Captions-only transcript extraction for research sourcing. Unlike the frame
 * pipeline (watch.py), this downloads NO video — only the subtitle track via
 * yt-dlp — so it is fast and robust across many sources. Prefers manual
 * captions, falls back to auto captions. No API keys, no Whisper. Hardened
 * subprocess (shell:false, filtered env, timeout, tree-kill, isolated tmp).
 */

const CAPTIONS_TIMEOUT_MS = Number(process.env.VIDEO_CAPTIONS_TIMEOUT_MS || 120_000);

function childEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "YT_DLP_PATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function timeToMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss)) * 1000 + Number(ms);
}

/** Parse a WebVTT string into segments, stripping inline tags and collapsing the
 *  rolling-duplicate lines YouTube auto-captions emit. */
export function parseVtt(vtt: string): ExtractedSegment[] {
  const body = vtt.replace(/^﻿/, "").replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = body.split(/\r?\n\r?\n+/).map((b) => b.trim()).filter(Boolean);
  const raw: { startMs: number; endMs: number; text: string }[] = [];
  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split(/\r?\n/);
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx === -1) continue;
    const [s, e] = lines[tIdx]!.split("-->").map((p) => p.trim().split(/\s+/)[0]!);
    const startMs = timeToMs(s!);
    const endMs = timeToMs(e!);
    if (startMs === null || endMs === null) continue;
    const text = lines
      .slice(tIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "") // inline <00:00:00.000> / <c> timing tags
      .replace(/\s+/g, " ")
      .trim();
    if (text) raw.push({ startMs, endMs, text });
  }

  // Collapse YouTube's rolling auto-caption duplication: consecutive cues where
  // the previous text is a prefix of the current one keep only the latest.
  const segments: ExtractedSegment[] = [];
  for (const cue of raw) {
    const prev = segments[segments.length - 1];
    if (prev && (prev.text === cue.text || cue.text.startsWith(prev.text))) {
      prev.text = cue.text;
      prev.endMs = cue.endMs;
      continue;
    }
    segments.push({ index: segments.length, startMs: cue.startMs, endMs: cue.endMs, text: cue.text });
  }
  segments.forEach((seg, i) => (seg.index = i));
  return segments;
}

async function ytDlpSubs(url: string, outDir: string, auto: boolean, signal?: AbortSignal): Promise<boolean> {
  const bin = process.env.YT_DLP_PATH || "yt-dlp";
  const args = [
    "--skip-download",
    auto ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt/best",
    "--convert-subs",
    "vtt",
    "--no-warnings",
    "--no-playlist",
    "-o",
    path.join(outDir, "cap.%(ext)s"),
    url,
  ];
  return new Promise<boolean>((resolve) => {
    const child = spawn(bin, args, { shell: false, cwd: outDir, env: childEnv(), stdio: ["ignore", "ignore", "ignore"] });
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    const kill = () => {
      if (child.pid) {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
        else child.kill("SIGKILL");
      }
      finish(false);
    };
    const timer = setTimeout(kill, CAPTIONS_TIMEOUT_MS);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

async function readFirstVtt(dir: string): Promise<string | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".vtt"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  // Prefer a plain "en" track over "en-orig"/regional variants.
  files.sort((a, b) => (a.includes(".en.") ? -1 : 0) - (b.includes(".en.") ? -1 : 0));
  try {
    return await readFile(path.join(dir, files[0]!), "utf8");
  } catch {
    return null;
  }
}

/** Fetch a video's captions (manual preferred, auto fallback) as an ExtractionResult. */
export async function fetchCaptions(url: string, signal?: AbortSignal): Promise<ExtractionResult> {
  const status = detectVideoEngine();
  const empty: ExtractionResult = { segments: [], framePaths: [], transcriptSource: "none", durationSec: null, warnings: [], dataLeftDevice: false };
  if (!status.hasYtDlp) return { ...empty, warnings: ["yt-dlp not available for caption extraction"] };
  if (!/^https?:\/\//i.test(url)) return empty;
  if (!validateUrlSyntax(url).ok) return empty;

  const workRoot = await mkdtemp(path.join(os.tmpdir(), "omni-caps-"));
  try {
    let source = "captions";
    let ok = await ytDlpSubs(url, workRoot, false, signal); // manual
    let vtt = ok ? await readFirstVtt(workRoot) : null;
    if (!vtt) {
      source = "auto-captions";
      ok = await ytDlpSubs(url, workRoot, true, signal); // auto fallback
      vtt = ok ? await readFirstVtt(workRoot) : null;
    }
    if (!vtt) return empty;
    const segments = parseVtt(vtt);
    return { segments, framePaths: [], transcriptSource: segments.length ? source : "none", durationSec: null, warnings: [], dataLeftDevice: false };
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
