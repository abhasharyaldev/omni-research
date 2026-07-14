"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";

const TASKS = ["summary", "claim-extraction", "chapter-outline", "key-quotes", "topic-list"] as const;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Video studio: caption-first transcript extraction (works with no external
 * tools) plus optional URL extraction via the pinned claude-video engine.
 * Analysis is provider-neutral and capability-gated — text-only providers never
 * claim to have seen frames.
 */
export default function VideosPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"subtitle" | "url">("subtitle");
  const [subtitle, setSubtitle] = useState("");
  const [subFormat, setSubFormat] = useState<"srt" | "vtt">("srt");
  const [videoUrl, setVideoUrl] = useState("");
  const [detailMode, setDetailMode] = useState("transcript");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [task, setTask] = useState<(typeof TASKS)[number]>("summary");
  const [analysis, setAnalysis] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: statusData } = useQuery({ queryKey: ["video-status"], queryFn: () => apiGet<{ status: any }>("/api/video/status") });
  const { data: videosData } = useQuery({ queryKey: ["videos", id], queryFn: () => apiGet<{ videos: any[] }>(`/api/projects/${id}/videos`) });
  const { data: activeVideo } = useQuery({
    queryKey: ["video", activeId],
    queryFn: () => apiGet<{ video: any }>(`/api/videos/${activeId}`),
    enabled: Boolean(activeId),
  });
  const status = statusData?.status;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["videos", id] });

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      await invalidate();
      return res;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Video studio</h1>
        <Link href={`/projects/${id}`} className="btn ml-auto">Project</Link>
      </div>

      {status && (
        <div className="panel mt-3 flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
          <span className={`badge ${status.available ? "badge-good" : "badge-warn"}`}>{status.available ? "extraction engine ready" : "captions-only mode"}</span>
          <span className="badge">pin {String(status.pin).slice(0, 10)}…</span>
          {status.version && <span className="badge">watch v{status.version}</span>}
          <span style={{ color: "var(--muted)" }}>{status.reason}</span>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2 space-y-3">
          <div className="panel p-4">
            <div className="mb-2 flex gap-1 border-b" style={{ borderColor: "var(--line)" }}>
              {(["subtitle", "url"] as const).map((t) => (
                <button key={t} className="px-3 py-1.5 text-sm font-semibold" style={tab === t ? { color: "var(--accent)", borderBottom: "2px solid var(--accent)" } : { color: "var(--muted)" }} onClick={() => setTab(t)}>
                  {t === "subtitle" ? "From subtitles" : "From URL"}
                </button>
              ))}
            </div>
            {tab === "subtitle" ? (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: "var(--muted)" }}>Paste an SRT or WebVTT file. Works offline — no external tools needed. Exact timestamps are preserved.</p>
                <select className="select w-auto" value={subFormat} onChange={(e) => setSubFormat(e.target.value as "srt" | "vtt")}>
                  <option value="srt">SRT</option>
                  <option value="vtt">WebVTT</option>
                </select>
                <textarea className="textarea font-mono text-xs" rows={8} value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder={"1\n00:00:01,000 --> 00:00:04,000\nHello"} aria-label="Subtitle content" />
                <button className="btn btn-primary" disabled={busy || !subtitle.trim()} onClick={() => run(() => apiPost(`/api/projects/${id}/videos/from-subtitle`, { content: subtitle, format: subFormat }))}>
                  {busy ? "Parsing…" : "Create transcript"}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  {status?.available ? "Extract captions/frames from a video URL via the pinned engine (local-first; audio never leaves the device unless you enable remote Whisper)." : "URL extraction needs yt-dlp + ffmpeg + the claude-video tooling. Until then, use subtitles."}
                </p>
                <input className="input" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://…" aria-label="Video URL" />
                <select className="select w-auto" value={detailMode} onChange={(e) => setDetailMode(e.target.value)}>
                  <option value="transcript">transcript (no frames)</option>
                  <option value="efficient">efficient (~24 frames)</option>
                  <option value="balanced">balanced (~60 frames)</option>
                  <option value="token-burner">token-burner (~100 frames)</option>
                </select>
                <button className="btn btn-primary" disabled={busy || !videoUrl.trim() || !status?.available} onClick={() => run(() => apiPost(`/api/projects/${id}/videos/from-url`, { url: videoUrl, detailMode }))}>
                  {busy ? "Extracting…" : "Extract video"}
                </button>
              </div>
            )}
            {error && <p className="mt-2 text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
          </div>

          <div className="panel p-3">
            <h2 className="mb-2 text-sm font-semibold">Videos</h2>
            <div className="space-y-1">
              {(videosData?.videos ?? []).map((v) => (
                <button key={v.id} className="block w-full rounded-md border px-3 py-2 text-left text-sm" style={{ borderColor: activeId === v.id ? "var(--accent)" : "var(--line)" }} onClick={() => { setActiveId(v.id); setAnalysis(null); }}>
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{v.title}</span>
                    <span className={`badge ml-auto ${v.status === "ready" ? "badge-good" : v.status === "failed" ? "badge-bad" : "badge-warn"}`}>{v.status}</span>
                  </span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>{v._count?.segments ?? 0} segments · {v.captionSource}{v.frameCount ? ` · ${v.frameCount} frames` : ""}</span>
                </button>
              ))}
              {(videosData?.videos ?? []).length === 0 && <p className="p-4 text-center text-xs" style={{ color: "var(--muted)" }}>No videos yet.</p>}
            </div>
          </div>
        </div>

        <div className="lg:col-span-3">
          {!activeVideo?.video && <div className="panel p-8 text-center text-sm" style={{ color: "var(--muted)" }}>Select a video to view its transcript and analyze it.</div>}
          {activeVideo?.video && (
            <div className="space-y-3">
              <div className="panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold">{activeVideo.video.title}</h2>
                  <span className="badge">{activeVideo.video.captionSource}</span>
                  {activeVideo.video.language && <span className="badge">{activeVideo.video.language}</span>}
                  {activeVideo.video.dataLeftDevice && <span className="badge badge-warn">data left device</span>}
                </div>
                {(activeVideo.video.warnings ?? []).length > 0 && (
                  <div className="mt-1 text-xs" style={{ color: "var(--warn)" }}>{(activeVideo.video.warnings as string[]).map((w, i) => <p key={i}>⚠ {w}</p>)}</div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select className="select w-auto" value={task} onChange={(e) => setTask(e.target.value as (typeof TASKS)[number])}>
                    {TASKS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={async () => { const res = await run(() => apiPost(`/api/videos/${activeVideo.video.id}/analyze`, { task, wantFrames: true })); if (res) setAnalysis(res); }}
                  >
                    {busy ? "Analyzing…" : "Analyze"}
                  </button>
                </div>
                {analysis && (
                  <div className="mt-3 text-sm">
                    <p className="text-xs" style={{ color: "var(--muted)" }}>{analysis.scopeNote} (provider: {analysis.provider}, mode: {analysis.mode})</p>
                    <p className="mt-2 whitespace-pre-wrap">{analysis.analysis}</p>
                  </div>
                )}
              </div>

              <div className="panel p-4">
                <h3 className="mb-2 text-sm font-semibold">Transcript ({activeVideo.video.segments?.length ?? 0} segments)</h3>
                <div className="max-h-96 space-y-1 overflow-y-auto text-sm">
                  {(activeVideo.video.segments ?? []).map((seg: any) => (
                    <p key={seg.id} className="flex gap-2">
                      <span className="shrink-0 font-mono text-xs" style={{ color: "var(--accent)" }}>{clock(seg.startMs)}</span>
                      <span>{seg.speaker && <strong>{seg.speaker}: </strong>}{seg.text}</span>
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
