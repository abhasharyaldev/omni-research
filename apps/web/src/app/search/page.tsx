"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { hitHref, Snippet } from "@/components/global-search";
import type { SearchHit } from "@omni/shared";

const ALL_TYPES = ["report", "evidence", "source", "claim", "citation", "project", "note"] as const;

function SearchPageInner() {
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(query);
  const [types, setTypes] = useState<string[]>([...ALL_TYPES]);
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minQuality, setMinQuality] = useState("");

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: { id: string; title: string }[] }>("/api/projects"),
  });

  const searchParamsString = new URLSearchParams({
    q: debounced,
    types: types.join(","),
    ...(projectId ? { projectId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(minQuality ? { minQuality } : {}),
    limit: "60",
  }).toString();

  const { data, isFetching } = useQuery({
    queryKey: ["search", searchParamsString],
    queryFn: () => apiGet<{ hits: SearchHit[]; total: number }>(`/api/search?${searchParamsString}`),
    enabled: debounced.trim().length >= 2,
  });

  const toggleType = (type: string) =>
    setTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]));

  return (
    <div>
      <h1 className="pt-2 text-2xl font-bold">Search everything</h1>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        Full-text search across claims, evidence, report text, sources, citations, notes, and project titles in
        all of your projects. Tip: <kbd>Ctrl/Cmd+K</kbd> opens quick search from any page.
      </p>

      <div className="panel mt-4 space-y-3 p-4">
        <input
          className="input text-base"
          placeholder="Search…"
          value={query}
          autoFocus
          aria-label="Search query"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {ALL_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="badge capitalize"
              style={types.includes(type) ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
              aria-pressed={types.includes(type)}
              onClick={() => toggleType(type)}
            >
              {type}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Project</label>
            <select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {(projectsData?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">From date</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">To date</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="label">Min source quality (0–100)</label>
            <input
              type="number"
              min={0}
              max={100}
              className="input"
              value={minQuality}
              onChange={(e) => setMinQuality(e.target.value)}
              placeholder="any"
            />
          </div>
        </div>
      </div>

      <div className="mt-4">
        {isFetching && <div className="skeleton h-24" />}
        {debounced.trim().length >= 2 && !isFetching && (
          <p className="mb-2 text-xs" style={{ color: "var(--muted)" }} aria-live="polite">
            {data?.hits.length ?? 0} result(s)
          </p>
        )}
        <div className="space-y-2">
          {(data?.hits ?? []).map((hit) => (
            <Link
              key={`${hit.type}-${hit.entityId}`}
              href={hitHref(hit)}
              className="panel block px-4 py-3 text-sm hover:opacity-80"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="badge capitalize">{hit.type}</span>
                <span className="font-semibold">{hit.title}</span>
                {hit.extra.qualityScore !== undefined && (
                  <span className={`badge ${hit.extra.qualityScore >= 65 ? "badge-good" : ""}`}>
                    quality {hit.extra.qualityScore}
                  </span>
                )}
                {hit.extra.verificationStatus && <span className="badge badge-warn">{hit.extra.verificationStatus}</span>}
                {hit.extra.marker !== undefined && <span className="badge badge-accent">[{hit.extra.marker}]</span>}
                <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                  {hit.projectTitle}
                  {hit.date ? ` · ${new Date(hit.date).toLocaleDateString()}` : ""}
                </span>
              </span>
              <span className="mt-1 block text-xs" style={{ color: "var(--muted)" }}>
                <Snippet text={hit.snippet} />
              </span>
            </Link>
          ))}
        </div>
        {debounced.trim().length < 2 && (
          <p className="p-8 text-center text-sm" style={{ color: "var(--muted)" }}>
            Type at least two characters to search.
          </p>
        )}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchPageInner />
    </Suspense>
  );
}
