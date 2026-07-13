"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, downloadExport } from "@/lib/api";
import { Markdown } from "@/components/markdown";
import { ReportSearchBar } from "@/components/report-search";

const TABS = ["report", "evidence", "sources", "news", "fact-check", "log"] as const;
type Tab = (typeof TABS)[number];

function ReportPageInner() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const fromUrl = search.get("tab");
    return TABS.includes(fromUrl as Tab) ? (fromUrl as Tab) : "report";
  });
  const [drawerMarker, setDrawerMarker] = useState<number | null>(null);
  const [findQuery, setFindQuery] = useState(search.get("find") ?? "");
  const [claimsInput, setClaimsInput] = useState("");
  const [factResults, setFactResults] = useState<any[] | null>(null);
  const [factBusy, setFactBusy] = useState(false);
  const reportBodyRef = useRef<HTMLDivElement>(null);

  const { data: reportData, isLoading } = useQuery({
    queryKey: ["report", id],
    queryFn: () => apiGet<{ report: any }>(`/api/projects/${id}/report`),
  });
  const { data: evidenceData } = useQuery({
    queryKey: ["evidence", id],
    queryFn: () => apiGet<{ evidence: any[] }>(`/api/projects/${id}/evidence`),
    enabled: tab === "evidence",
  });
  const { data: sourcesData } = useQuery({
    queryKey: ["sources", id],
    queryFn: () => apiGet<{ sources: any[] }>(`/api/projects/${id}/sources`),
    enabled: tab === "sources",
  });
  const { data: newsData } = useQuery({
    queryKey: ["news", id],
    queryFn: () => apiGet<{ events: any[] }>(`/api/projects/${id}/news`),
    enabled: tab === "news",
  });
  const { data: projectData } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiGet<{ project: any }>(`/api/projects/${id}`),
  });

  const report = reportData?.report;
  const citation = report?.citations?.find((c: any) => c.marker === drawerMarker);
  const latestRun = projectData?.project?.runs?.[0];
  const sortedMarkers: number[] = useMemo(
    () => (report?.citations ?? []).map((c: any) => c.marker).sort((a: number, b: number) => a - b),
    [report]
  );

  const gotoAdjacentCitation = (delta: number) => {
    if (sortedMarkers.length === 0) return;
    if (drawerMarker === null) {
      setDrawerMarker(sortedMarkers[0]!);
      return;
    }
    const index = sortedMarkers.indexOf(drawerMarker);
    const next = sortedMarkers[(index + delta + sortedMarkers.length) % sortedMarkers.length];
    setDrawerMarker(next ?? null);
  };

  // J/K navigate citations; Esc closes the drawer. Never fires while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j" || event.key === "J") gotoAdjacentCitation(1);
      if (event.key === "k" || event.key === "K") gotoAdjacentCitation(-1);
      if (event.key === "Escape" && drawerMarker !== null) setDrawerMarker(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerMarker, sortedMarkers]);

  const runFactCheck = async () => {
    setFactBusy(true);
    try {
      const claims = claimsInput.split("\n").map((c) => c.trim()).filter(Boolean);
      const result = await apiPost<{ results: any[] }>(`/api/projects/${id}/fact-check`, { claims });
      setFactResults(result.results);
    } finally {
      setFactBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">{report?.title ?? "Report"}</h1>
        {report?.verifiedAt && <span className="badge badge-good">citations verified</span>}
        {report?.providerUsed && <span className="badge">provider: {report.providerUsed}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {tab === "report" && (
            <ReportSearchBar
              containerRef={reportBodyRef}
              query={findQuery}
              onQueryChange={setFindQuery}
              initialOpen={Boolean(search.get("find"))}
            />
          )}
          <Link href={`/projects/${id}`} className="btn">Project</Link>
          <select
            className="select w-auto"
            defaultValue=""
            aria-label="Export report"
            onChange={(e) => {
              if (e.target.value) void downloadExport(id, e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>Export…</option>
            <option value="markdown">Markdown</option>
            <option value="html">HTML (print to PDF)</option>
            <option value="json">JSON archive</option>
            <option value="csv-sources">CSV source list</option>
            <option value="csv-flashcards">CSV flashcards</option>
            <option value="bibliography">Bibliography</option>
          </select>
          <button className="btn" onClick={() => apiPost(`/api/projects/${id}/report/regenerate`)}>
            Regenerate
          </button>
        </div>
      </div>

      <div className="mt-4 flex gap-1 border-b" style={{ borderColor: "var(--line)" }}>
        {TABS.map((t) => (
          <button
            key={t}
            className="px-3 py-2 text-sm font-semibold capitalize"
            style={tab === t ? { color: "var(--accent)", borderBottom: "2px solid var(--accent)" } : { color: "var(--muted)" }}
            onClick={() => setTab(t)}
          >
            {t.replace("-", " ")}
          </button>
        ))}
      </div>

      {tab === "report" && (
        <div ref={reportBodyRef} className="mt-5 max-w-3xl space-y-6">
          {isLoading && <div className="skeleton h-40" />}
          {!isLoading && !report && (
            <div className="panel p-8 text-center text-sm" style={{ color: "var(--muted)" }}>
              No report yet. Run research first from the project page.
            </div>
          )}
          {report?.sections?.map((section: any) => (
            <section key={section.id} className="panel p-5">
              <h2 className="mb-2 text-lg font-bold">{section.title}</h2>
              <Markdown content={section.contentMd} onCitationClick={setDrawerMarker} highlight={findQuery} />
            </section>
          ))}
          {report?.methodology && (
            <section className="panel p-5 text-sm" style={{ color: "var(--muted)" }}>
              <Markdown content={report.methodology} highlight={findQuery} />
            </section>
          )}
          {report?.citations?.length > 0 && (
            <section className="panel p-5">
              <h2 className="mb-2 text-lg font-bold">Sources</h2>
              <ol className="space-y-2 text-sm">
                {report.citations.map((c: any) => (
                  <li key={c.id}>
                    <button className="citation-marker mr-1" onClick={() => setDrawerMarker(c.marker)}>[{c.marker}]</button>
                    <span className="font-semibold">{c.source.title ?? "Untitled"}</span>{" "}
                    <span style={{ color: "var(--muted)" }}>
                      — {c.source.author ?? "Author unavailable"} · {c.source.publisher ?? c.source.siteName ?? ""} ·{" "}
                      {c.source.publishedAt ? new Date(c.source.publishedAt).toLocaleDateString() : "Publication date unavailable"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      {tab === "evidence" && (
        <div className="mt-5 space-y-2">
          {(evidenceData?.evidence ?? []).map((e: any) => (
            <div key={e.id} className="panel p-4 text-sm">
              <p className="font-semibold">{e.claim}</p>
              <blockquote className="mt-1 border-l-2 pl-3" style={{ borderColor: "var(--accent)", color: "var(--muted)" }}>
                “{e.evidenceText}”
              </blockquote>
              <p className="mt-2 flex flex-wrap gap-2 text-xs" style={{ color: "var(--muted)" }}>
                <span className="badge">{e.evidenceType}</span>
                <span className={`badge ${e.evidenceStrength === "strong" ? "badge-good" : e.evidenceStrength === "weak" ? "badge-warn" : ""}`}>{e.evidenceStrength}</span>
                {e.flaggedInjection && <span className="badge badge-bad">injection-flagged source</span>}
                <a className="underline" href={e.source.finalUrl ?? e.source.url} target="_blank" rel="noopener noreferrer nofollow">
                  {e.source.title ?? e.source.url}
                </a>
                {e.sourceLocation && <span>({e.sourceLocation})</span>}
              </p>
            </div>
          ))}
          {evidenceData?.evidence?.length === 0 && (
            <p className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>No evidence records yet.</p>
          )}
        </div>
      )}

      {tab === "sources" && (
        <div className="mt-5 space-y-2">
          {(sourcesData?.sources ?? []).map((s: any) => (
            <SourceRow key={s.id} source={s} />
          ))}
        </div>
      )}

      {tab === "news" && (
        <div className="mt-5 space-y-3">
          {(newsData?.events ?? []).length === 0 && (
            <p className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>
              No news events (only news-catchup projects build a timeline).
            </p>
          )}
          {(newsData?.events ?? []).map((event: any) => (
            <div key={event.id} className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-bold">{event.headline}</h3>
                <span className={`badge ${event.confidence === "high" ? "badge-good" : event.confidence === "low" ? "badge-warn" : ""}`}>
                  confidence: {event.confidence}
                </span>
                {event.eventDate && (
                  <span className="badge">event date: {new Date(event.eventDate).toLocaleDateString()}</span>
                )}
              </div>
              {event.summaryMd && <div className="mt-2 text-sm"><Markdown content={event.summaryMd} /></div>}
              {event.whyItMatters && <p className="mt-1 text-sm"><span className="font-semibold">Why it matters:</span> {event.whyItMatters}</p>}
              <div className="mt-2 space-y-1 text-xs" style={{ color: "var(--muted)" }}>
                {event.articles.map((a: any) => (
                  <p key={a.id}>
                    <a className="underline" href={a.source.finalUrl ?? a.source.url} target="_blank" rel="noopener noreferrer nofollow">
                      {a.source.title ?? a.source.url}
                    </a>{" "}
                    ({a.source.publisher ?? "unknown"}, published {a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : "date unavailable"})
                    {a.isSyndicated && <span className="badge badge-warn ml-1">syndicated copy</span>}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "fact-check" && (
        <div className="mt-5 max-w-3xl space-y-4">
          <div className="panel p-4">
            <p className="label">Claims to check (one per line, evaluated against this project&apos;s stored evidence)</p>
            <textarea className="textarea" rows={4} value={claimsInput} onChange={(e) => setClaimsInput(e.target.value)} />
            <button className="btn btn-primary mt-3" disabled={factBusy || !claimsInput.trim()} onClick={runFactCheck}>
              {factBusy ? "Checking…" : "Check claims"}
            </button>
          </div>
          {factResults?.map((result) => (
            <div key={result.claimId} className="panel p-4 text-sm">
              <p className="font-semibold">{result.claim}</p>
              <span className={`badge mt-2 ${["well-supported", "mostly-supported"].includes(result.status) ? "badge-good" : ["unsupported", "disputed"].includes(result.status) ? "badge-bad" : "badge-warn"}`}>
                {result.status}
              </span>
              <p className="mt-2" style={{ color: "var(--muted)" }}>{result.explanation}</p>
              {result.supporting.length > 0 && (
                <p className="mt-2 text-xs"><span className="font-semibold">Supporting:</span> {result.supporting.map((s: any) => `“${s.excerpt}”`).join(" · ")}</p>
              )}
              {result.opposing.length > 0 && (
                <p className="mt-1 text-xs"><span className="font-semibold">Opposing:</span> {result.opposing.map((s: any) => `“${s.excerpt}”`).join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "log" && latestRun && (
        <div className="mt-5">
          <Link href={`/runs/${latestRun.id}`} className="btn">Open full run view</Link>
        </div>
      )}

      {citation && (
        <div
          className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l p-5 shadow-2xl"
          style={{ background: "var(--panel)", borderColor: "var(--line)" }}
          role="complementary"
          aria-label={`Citation ${citation.marker}`}
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold">Citation [{citation.marker}]</h3>
            <div className="flex items-center gap-1">
              <button className="btn px-2 py-1" title="Previous citation (K)" aria-label="Previous citation" onClick={() => gotoAdjacentCitation(-1)}>
                ←
              </button>
              <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                {sortedMarkers.indexOf(citation.marker) + 1}/{sortedMarkers.length}
              </span>
              <button className="btn px-2 py-1" title="Next citation (J)" aria-label="Next citation" onClick={() => gotoAdjacentCitation(1)}>
                →
              </button>
              <button className="btn" onClick={() => setDrawerMarker(null)}>Close</button>
            </div>
          </div>
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-base font-semibold">{citation.source.title ?? "Untitled"}</p>
            <dl className="grid grid-cols-3 gap-1" style={{ color: "var(--muted)" }}>
              <dt>Author</dt><dd className="col-span-2">{citation.source.author ?? "Author unavailable"}</dd>
              <dt>Publisher</dt><dd className="col-span-2">{citation.source.publisher ?? "—"}</dd>
              <dt>Published</dt><dd className="col-span-2">{citation.source.publishedAt ? new Date(citation.source.publishedAt).toLocaleDateString() : "Publication date unavailable"}</dd>
              <dt>Retrieved</dt><dd className="col-span-2">{citation.source.retrievedAt ? new Date(citation.source.retrievedAt).toLocaleString() : "—"}</dd>
              <dt>Locator</dt><dd className="col-span-2">{citation.locator ?? (citation.pageNumber ? `page ${citation.pageNumber}` : "—")}</dd>
              <dt>Verified</dt>
              <dd className="col-span-2">
                <span className={`badge ${citation.verified ? "badge-good" : "badge-bad"}`}>{citation.verified ? "verified" : "unverified"}</span>{" "}
                {citation.verifyNote}
              </dd>
            </dl>
            <div>
              <p className="label">Supporting excerpt</p>
              <blockquote className="border-l-2 pl-3" style={{ borderColor: "var(--accent)" }}>
                “{citation.quotedText}”
              </blockquote>
            </div>
            {citation.evidence?.claim && (
              <div>
                <p className="label">Claim using this source</p>
                <p>{citation.evidence.claim}</p>
              </div>
            )}
            <div>
              <p className="label">Source quality</p>
              <p style={{ color: "var(--muted)" }}>
                {citation.source.classification} · score {citation.source.qualityScore}/100
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs" style={{ color: "var(--muted)" }}>
                {(citation.source.scoreReasons ?? []).map((reason: string, i: number) => <li key={i}>{reason}</li>)}
              </ul>
            </div>
            <a className="btn" href={citation.source.finalUrl ?? citation.source.url} target="_blank" rel="noopener noreferrer nofollow">
              Open original ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function SourceRow({ source }: { source: any }) {
  return (
    <div className="panel flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
      <span className="font-semibold">{source.title ?? source.url}</span>
      <span className="badge">{source.classification}</span>
      <span className={`badge ${source.qualityScore >= 65 ? "badge-good" : source.qualityScore < 45 ? "badge-warn" : ""}`}>
        {source.qualityScore}/100
      </span>
      {source.duplicateOfId && <span className="badge badge-warn">duplicate</span>}
      {source.paywallFlag && <span className="badge badge-warn">paywall?</span>}
      <a className="ml-auto text-xs underline" style={{ color: "var(--accent)" }}
        href={source.finalUrl ?? source.url} target="_blank" rel="noopener noreferrer nofollow">
        open ↗
      </a>
    </div>
  );
}

export default function ReportPage() {
  return (
    <Suspense>
      <ReportPageInner />
    </Suspense>
  );
}
