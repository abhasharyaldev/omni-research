"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";

const CLASSIFICATIONS = [
  "", "primary-source", "peer-reviewed", "government", "academic", "journalism",
  "educational-reference", "industry", "expert-commentary", "opinion", "advocacy",
  "user-generated", "unknown",
];

export default function SourceLibraryPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [classification, setClassification] = useState("");
  const [sort, setSort] = useState("quality");
  const [newUrl, setNewUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<any | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["sources", id, q, classification, sort],
    queryFn: () =>
      apiGet<{ sources: any[] }>(
        `/api/projects/${id}/sources?q=${encodeURIComponent(q)}&classification=${classification}&sort=${sort}`
      ),
  });

  const addSource = useMutation({
    mutationFn: () => apiPost(`/api/projects/${id}/sources`, { url: newUrl.trim() }),
    onSuccess: async () => {
      setNewUrl("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["sources", id] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not add source"),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sources", id] });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Source library</h1>
        <Link href={`/projects/${id}`} className="btn ml-auto">Back to project</Link>
      </div>

      <div className="panel mt-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-48 flex-1">
          <label className="label">Search</label>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="title, URL, publisher…" />
        </div>
        <div>
          <label className="label">Classification</label>
          <select className="select" value={classification} onChange={(e) => setClassification(e.target.value)}>
            {CLASSIFICATIONS.map((c) => (
              <option key={c} value={c}>{c || "all"}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Sort</label>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="quality">Quality score</option>
            <option value="date">Publication date</option>
            <option value="retrieved">Retrieval date</option>
          </select>
        </div>
      </div>

      <div className="panel mt-3 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-64 flex-1">
          <label className="label">Add a source URL (crawled with all safety policies on the next run)</label>
          <input className="input" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://…" />
        </div>
        <button className="btn btn-primary" disabled={!newUrl.trim() || addSource.isPending} onClick={() => addSource.mutate()}>
          Add source
        </button>
        {error && <p className="w-full text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
      </div>

      {isLoading && <div className="skeleton mt-4 h-40" />}
      <div className="mt-4 space-y-2">
        {(data?.sources ?? []).map((source) => (
          <div key={source.id} className="panel px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <button className="font-semibold hover:underline" onClick={() => setPreview(preview?.id === source.id ? null : source)}>
                {source.title ?? source.url}
              </button>
              <span className="badge">{source.classification}</span>
              <span className={`badge ${source.qualityScore >= 65 ? "badge-good" : source.qualityScore < 45 ? "badge-warn" : ""}`}>{source.qualityScore}/100</span>
              {source.status !== "retrieved" && <span className="badge badge-warn">{source.status}</span>}
              {source.duplicateOfId && <span className="badge badge-warn">duplicate</span>}
              {source._count?.duplicates > 0 && <span className="badge">{source._count.duplicates} duplicate(s) grouped</span>}
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                {source._count?.evidence ?? 0} evidence
              </span>
              <div className="flex gap-1">
                <a className="btn" href={source.finalUrl ?? source.url} target="_blank" rel="noopener noreferrer nofollow">↗</a>
                <button className="btn" title="Re-crawl" onClick={async () => { await apiPost(`/api/sources/${source.id}/recrawl`); }}>
                  ⟳
                </button>
                <button className="btn" title={source.status === "archived" ? "Unarchive" : "Archive"}
                  onClick={async () => { await apiPatch(`/api/sources/${source.id}`, { status: source.status === "archived" ? "retrieved" : "archived" }); await invalidate(); }}>
                  🗀
                </button>
                <button className="btn btn-danger" title="Delete"
                  onClick={async () => { if (confirm("Delete this source and its evidence?")) { await apiDelete(`/api/sources/${source.id}`); await invalidate(); } }}>
                  ✕
                </button>
              </div>
            </div>
            {preview?.id === source.id && (
              <div className="mt-3 border-t pt-3 text-xs" style={{ borderColor: "var(--line)" }}>
                <dl className="grid grid-cols-2 gap-1 sm:grid-cols-4" style={{ color: "var(--muted)" }}>
                  <dt>Author</dt><dd>{source.author ?? "Author unavailable"}</dd>
                  <dt>Publisher</dt><dd>{source.publisher ?? "—"}</dd>
                  <dt>Published</dt><dd>{source.publishedAt ? new Date(source.publishedAt).toLocaleDateString() : "unavailable"}</dd>
                  <dt>Retrieved</dt><dd>{source.retrievedAt ? new Date(source.retrievedAt).toLocaleString() : "—"}</dd>
                  <dt>Words</dt><dd>{source.wordCount}</dd>
                  <dt>Method</dt><dd>{source.crawlMethod ?? "—"}</dd>
                  <dt>Language</dt><dd>{source.language ?? "—"}</dd>
                  <dt>Content hash</dt><dd className="truncate">{source.contentHash?.slice(0, 16) ?? "—"}</dd>
                </dl>
                {source.excerpt && <p className="mt-2 italic" style={{ color: "var(--muted)" }}>“{source.excerpt.slice(0, 400)}…”</p>}
                <div className="mt-2">
                  <p className="label">Score reasons</p>
                  <ul className="list-disc pl-5" style={{ color: "var(--muted)" }}>
                    {(source.scoreReasons ?? []).map((r: string, i: number) => <li key={i}>{r}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </div>
        ))}
        {data?.sources?.length === 0 && (
          <p className="p-8 text-center text-sm" style={{ color: "var(--muted)" }}>No sources match.</p>
        )}
      </div>
    </div>
  );
}
