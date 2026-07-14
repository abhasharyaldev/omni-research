import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Detection of the pinned upstream video tooling (bradautomates/claude-video,
 * MIT). The upstream name is branding only — extraction produces neutral
 * artifacts analyzable by ANY provider (see analysis.ts). Nothing is executed
 * here; this only reports what is installed so the app degrades gracefully and
 * records honest provenance.
 */

/** Pinned/audited upstream commit (recorded on every VideoAsset). */
export const CLAUDE_VIDEO_PIN = "83da59fa78c3eee9e20f515fe75c438bb5166efd";

export type VideoEngineStatus = {
  available: boolean;
  watchScript: string | null;
  version: string | null;
  pin: string;
  hasYtDlp: boolean;
  hasFfmpeg: boolean;
  reason: string;
  /** Caption/subtitle import works with NO binaries — always true. */
  captionImportAlways: true;
};

const CANDIDATE_ROOTS = [
  process.env.CLAUDE_VIDEO_DIR,
  path.join(os.homedir(), ".claude", "plugins", "marketplaces", "claude-video"),
  path.join(os.homedir(), ".claude", "plugins", "cache", "claude-video", "watch", "0.1.3"),
].filter((p): p is string => Boolean(p));

function findWatchScript(): { script: string; version: string | null } | null {
  for (const root of CANDIDATE_ROOTS) {
    const script = path.join(root, "scripts", "watch.py");
    if (existsSync(script)) {
      const version = root.match(/watch[\\/](\d+\.\d+\.\d+)/)?.[1] ?? null;
      return { script, version };
    }
  }
  return null;
}

function onPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const names = process.platform === "win32" ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];
  return dirs.some((dir) => names.some((name) => dir && existsSync(path.join(dir, name))));
}

export function detectVideoEngine(): VideoEngineStatus {
  const found = findWatchScript();
  const hasYtDlp = onPath("yt-dlp") || Boolean(process.env.YT_DLP_PATH);
  const hasFfmpeg = onPath("ffmpeg") || Boolean(process.env.FFMPEG_PATH);
  const hasPython = onPath("python") || onPath("python3");

  let reason: string;
  const available = Boolean(found) && hasPython && hasYtDlp && hasFfmpeg;
  if (available) {
    reason = "Video extraction ready (URL/local download + frames + caption/Whisper transcript).";
  } else if (!found) {
    reason = "claude-video tooling not found. Install: `/plugin marketplace add bradautomates/claude-video` then `/plugin install watch@claude-video`, or `npx skills add bradautomates/claude-video -g`. Subtitle/caption import still works without it.";
  } else {
    const missing = [!hasPython && "python", !hasYtDlp && "yt-dlp", !hasFfmpeg && "ffmpeg"].filter(Boolean).join(", ");
    reason = `claude-video found but missing: ${missing}. Subtitle/caption import still works without these.`;
  }

  return {
    available,
    watchScript: found?.script ?? null,
    version: found?.version ?? null,
    pin: CLAUDE_VIDEO_PIN,
    hasYtDlp,
    hasFfmpeg,
    reason,
    captionImportAlways: true,
  };
}
