"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiPost, ApiError } from "@/lib/api";
import type { RunPreview } from "@omni/shared";

/** Reassuring, roughly time-accurate status while the ~55s plan call runs. */
function waitMessage(sec: number): string {
  if (sec < 4) return "Generating the research plan…";
  if (sec < 15) return "Working through subquestions and key terms…";
  if (sec < 30) return "Drafting discovery queries…";
  if (sec < 50) return "Finalizing the plan — this usually takes ~50–60s…";
  return "Almost there — wrapping up…";
}

/**
 * Research-run preview dialog: shows what WOULD be crawled (discovered URLs,
 * provider labels, robots pre-checks, duplicate/low-quality flags, workload)
 * and lets the user remove/add sources, exclude domains, and tune limits
 * before approving. Approval starts the run with the exact approved URL list.
 */
export function RunPreviewDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maxSources, setMaxSources] = useState(15);
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxTurns, setMaxTurns] = useState(2);
  const [highQualityOnly, setHighQualityOnly] = useState(false);
  const [excludeOpinion, setExcludeOpinion] = useState(false);
  const [extraUrl, setExtraUrl] = useState("");
  const [excludeDomain, setExcludeDomain] = useState("");
  const [excludedDomains, setExcludedDomains] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);

  // Tick an elapsed-seconds counter while a preview is building so the wait
  // shows visible progress instead of a static spinner that reads as a hang.
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading]);

  const loadPreview = async (
    extraUrls: string[] = [],
    domains: string[] = excludedDomains,
    forceReplan = false
  ) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiPost<{ preview: RunPreview }>(`/api/projects/${projectId}/research-runs/preview`, {
        maxSources,
        crawlLimits: { maxDepth },
        excludeDomains: domains,
        extraUrls,
        forceReplan,
      });
      setPreview(response.preview);
      const next: Record<string, boolean> = {};
      for (const candidate of response.preview.candidates) next[candidate.url] = candidate.included;
      setIncluded(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  };

  const approve = async () => {
    if (!preview) return;
    setStarting(true);
    setError(null);
    try {
      const approvedUrls = preview.candidates.filter((c) => included[c.url]).map((c) => c.url);
      const excludedUrls = preview.candidates.filter((c) => !included[c.url]).map((c) => c.url);
      const { run } = await apiPost<{ run: { id: string } }>(`/api/projects/${projectId}/research-runs`, {
        approvedUrls,
        excludedUrls,
        excludeDomains: excludedDomains,
        planJson: preview.plan,
        maxSources,
        maxResearchTurns: maxTurns,
        highQualityOnly,
        excludeOpinion,
        planOverrides: { crawlLimits: { maxDepth } },
      });
      router.push(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the run");
      setStarting(false);
    }
  };

  const includedCount = preview ? preview.candidates.filter((c) => included[c.url]).length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Research run preview"
    >
      <div className="panel w-full max-w-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Run preview</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {!preview && (
          <div className="mt-4 space-y-4">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              The preview generates the research plan and discovers candidate sources — without crawling
              any content pages — so you can approve exactly what gets crawled.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Target sources</label>
                <input type="number" min={1} max={100} className="input" value={maxSources} onChange={(e) => setMaxSources(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Crawl depth (0–4)</label>
                <input type="number" min={0} max={4} className="input" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Follow-up research turns (0–4)</label>
                <input type="number" min={0} max={4} className="input" value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
              </div>
            </div>
            <button className="btn btn-primary" disabled={loading} onClick={() => loadPreview()}>
              {loading ? `${waitMessage(elapsed)} (${elapsed}s)` : "Build preview"}
            </button>
            {loading && (
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                The first preview builds the research plan (~1 min). Adjusting sources afterward is instant.
              </p>
            )}
          </div>
        )}

        {preview && (
          <div className="mt-4 space-y-4">
            <div className="panel p-3 text-sm">
              <p className="font-semibold">Plan: {preview.plan.mainQuestion}</p>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                {preview.plan.subquestions.length} subquestions · queries:{" "}
                {preview.queries.map((q) => `${q.query.slice(0, 40)} (${q.providerId}: ${q.results})`).join(" · ") || "none"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="badge badge-accent">{includedCount} of {preview.candidates.length} candidates approved</span>
              <span className="badge">depth ≤ {preview.workload.maxDepth}</span>
              <span className="badge">≤ {preview.workload.maxResearchTurns} follow-up turn(s)</span>
              <span className="badge">{preview.workload.processingStages} pipeline stages</span>
              <label className="ml-auto flex items-center gap-1 text-xs">
                <input type="checkbox" checked={highQualityOnly} onChange={(e) => setHighQualityOnly(e.target.checked)} />
                high-quality only
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={excludeOpinion} onChange={(e) => setExcludeOpinion(e.target.checked)} />
                exclude opinion
              </label>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>{preview.workload.note}</p>

            {preview.warnings.length > 0 && (
              <div className="panel border p-3 text-xs" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>
                {preview.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
              </div>
            )}

            <div className="max-h-80 space-y-1 overflow-y-auto">
              {preview.candidates.map((candidate) => (
                <label
                  key={candidate.url}
                  className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
                  style={{ borderColor: "var(--line)", opacity: candidate.robots === "disallowed" ? 0.5 : 1 }}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(included[candidate.url])}
                    disabled={candidate.robots === "disallowed" || candidate.flags.some((f) => f.startsWith("blocked-by-rules"))}
                    onChange={(e) => setIncluded((cur) => ({ ...cur, [candidate.url]: e.target.checked }))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{candidate.title}</span>
                    <span className="block truncate" style={{ color: "var(--muted)" }}>{candidate.url}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      <span className="badge">{candidate.providerId}</span>
                      {!candidate.flags.includes("video-transcript-source") && candidate.robots === "disallowed" && <span className="badge badge-bad">robots.txt disallows</span>}
                      {!candidate.flags.includes("video-transcript-source") && candidate.robots === "allowed" && <span className="badge badge-good">robots ok</span>}
                      {candidate.publishedAt && <span className="badge">{new Date(candidate.publishedAt).toLocaleDateString()}</span>}
                      {candidate.flags.map((flag) =>
                        flag === "video-transcript-source" ? (
                          <span key={flag} className="badge badge-accent" title="Transcribed via captions when the run starts">🎬 video transcript source</span>
                        ) : (
                          <span key={flag} className="badge badge-warn">{flag}</span>
                        )
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn px-2 py-0.5 text-xs"
                    title={`Exclude ${candidate.domain} entirely`}
                    onClick={(e) => {
                      e.preventDefault();
                      const domains = [...new Set([...excludedDomains, candidate.domain])];
                      setExcludedDomains(domains);
                      setIncluded((cur) => {
                        const next = { ...cur };
                        for (const c of preview.candidates) if (c.domain === candidate.domain) next[c.url] = false;
                        return next;
                      });
                    }}
                  >
                    − domain
                  </button>
                </label>
              ))}
              {preview.candidates.length === 0 && (
                <p className="p-4 text-center text-sm" style={{ color: "var(--muted)" }}>
                  No candidates. Add starting URLs below or on the project settings.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52 flex-1">
                <label className="label">Add a URL to this run</label>
                <input className="input" value={extraUrl} onChange={(e) => setExtraUrl(e.target.value)} placeholder="https://…" />
              </div>
              <button
                className="btn"
                disabled={!extraUrl.trim() || loading}
                onClick={() => {
                  void loadPreview([extraUrl.trim()]);
                  setExtraUrl("");
                }}
              >
                Add & re-preview
              </button>
              <div className="min-w-40">
                <label className="label">Exclude domain</label>
                <input className="input" value={excludeDomain} onChange={(e) => setExcludeDomain(e.target.value)} placeholder="example.com" />
              </div>
              <button
                className="btn"
                disabled={!excludeDomain.trim()}
                onClick={() => {
                  const domains = [...new Set([...excludedDomains, excludeDomain.trim().toLowerCase()])];
                  setExcludedDomains(domains);
                  setExcludeDomain("");
                  void loadPreview([], domains);
                }}
              >
                Exclude
              </button>
            </div>
            {excludedDomains.length > 0 && (
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Excluded domains for this run: {excludedDomains.join(", ")}
              </p>
            )}

            {error && <p className="text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={starting || includedCount === 0} onClick={approve}>
                {starting ? "Starting…" : `Approve & crawl ${includedCount} source(s)`}
              </button>
              <button
                className="btn"
                disabled={loading}
                title="Regenerate the research plan from scratch (use after editing project settings)"
                onClick={() => loadPreview([], excludedDomains, true)}
              >
                {loading ? `Rebuilding… (${elapsed}s)` : "Rebuild preview"}
              </button>
            </div>
          </div>
        )}
        {error && !preview && <p className="mt-3 text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
      </div>
    </div>
  );
}
