import { spawn } from "node:child_process";
import { validateUrlSyntax } from "@omni/security";
import { detectVideoEngine } from "./detection.js";

/**
 * Best-effort video metadata via yt-dlp's JSON dump (no download). Mirrors the
 * hardening in extract.ts: shell:false, fixed args, filtered env (no API keys),
 * timeout + process-tree kill, output cap, and an SSRF check on the URL. Never
 * throws — on any problem it returns {} and the caller falls back to the URL.
 */

export type VideoMetadata = {
  title?: string;
  uploader?: string;
  uploadDate?: Date;
  durationSec?: number;
  webpageUrl?: string;
};

const META_TIMEOUT_MS = Number(process.env.VIDEO_META_TIMEOUT_MS || 60_000);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function childEnv(): NodeJS.ProcessEnv {
  const allow = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "YT_DLP_PATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** yt-dlp upload_date is "YYYYMMDD". */
function parseUploadDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !/^\d{8}$/.test(raw)) return undefined;
  const d = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function fetchVideoMetadata(url: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const status = detectVideoEngine();
  if (!status.hasYtDlp) return {};
  if (!/^https?:\/\//i.test(url)) return {};
  const safety = validateUrlSyntax(url);
  if (!safety.ok) return {};

  const bin = process.env.YT_DLP_PATH || "yt-dlp";
  const args = ["--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", url];

  try {
    const json = await new Promise<string>((resolve, reject) => {
      const child = spawn(bin, args, { shell: false, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let killed = false;
      const kill = () => {
        killed = true;
        if (child.pid) {
          if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
          else child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(kill, META_TIMEOUT_MS);
      signal?.addEventListener("abort", kill, { once: true });
      child.stdout.on("data", (c: Buffer) => {
        stdout += c.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) kill();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed || code !== 0) reject(new Error(`yt-dlp metadata failed (exit ${code})`));
        else resolve(stdout);
      });
    });

    const meta = JSON.parse(json) as Record<string, unknown>;
    return {
      title: typeof meta.title === "string" ? meta.title : undefined,
      uploader: typeof meta.uploader === "string" ? meta.uploader : typeof meta.channel === "string" ? meta.channel : undefined,
      uploadDate: parseUploadDate(meta.upload_date),
      durationSec: typeof meta.duration === "number" ? meta.duration : undefined,
      webpageUrl: typeof meta.webpage_url === "string" ? meta.webpage_url : undefined,
    };
  } catch {
    return {};
  }
}
