"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";

const KINDS = ["auto-detect", "pasted-text", "url-list", "markdown", "plain-text", "csv", "tsv", "pdf", "docx", "bibtex", "srt", "vtt", "rss", "atom", "sitemap", "omni-bundle"] as const;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Universal import (v1: text formats). Workflow: choose type (or auto-detect)
 * → paste or pick a file → server parses & previews → review warnings →
 * confirm → per-item results. Every payload is validated server-side.
 */
export default function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<(typeof KINDS)[number]>("auto-detect");
  const [content, setContent] = useState("");
  const [contentBase64, setContentBase64] = useState<string | undefined>();
  const [filename, setFilename] = useState<string | undefined>();
  const [preview, setPreview] = useState<{ jobId: string; preview: any; duplicateOfJobId?: string } | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: jobsData } = useQuery({
    queryKey: ["imports", id],
    queryFn: () => apiGet<{ jobs: any[] }>(`/api/projects/${id}/imports`),
  });

  const readFile = (file: File) => {
    const isBinary = /\.(pdf|docx)$/i.test(file.name);
    const limit = isBinary ? 20 * 1024 * 1024 : MAX_BYTES;
    if (file.size > limit) {
      setError(`File exceeds the ${Math.round(limit / 1_048_576)} MB import limit`);
      return;
    }
    setError(null);
    setContent("");
    setContentBase64(undefined);
    const reader = new FileReader();
    if (isBinary) {
      // PDF/DOCX → base64 (signature-checked server-side; extensions untrusted).
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        setContentBase64(dataUrl.slice(dataUrl.indexOf(",") + 1));
        setFilename(file.name);
      };
      reader.onerror = () => setError("Could not read the file");
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => {
        setContent(String(reader.result ?? ""));
        setFilename(file.name);
      };
      reader.onerror = () => setError("Could not read the file");
      reader.readAsText(file);
    }
  };

  const buildPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await apiPost<{ jobId: string; preview: any; duplicateOfJobId?: string }>(`/api/projects/${id}/imports`, {
        ...(contentBase64 ? { contentBase64 } : { content }),
        filename,
        ...(kind !== "auto-detect" ? { kind } : {}),
      });
      setPreview(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const { counts } = await apiPost<{ counts: any }>(`/api/imports/${preview.jobId}/confirm`, {});
      const job = await apiGet<{ job: any }>(`/api/imports/${preview.jobId}`);
      setResult({ counts, job: job.job });
      setPreview(null);
      setContent("");
      setContentBase64(undefined);
      setFilename(undefined);
      await queryClient.invalidateQueries({ queryKey: ["imports", id] });
      await queryClient.invalidateQueries({ queryKey: ["sources", id] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Import research</h1>
        <Link href={`/projects/${id}`} className="btn ml-auto">Project</Link>
      </div>
      <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--muted)" }}>
        Bring existing research in as sources with full provenance. Supported now: pasted text, URL lists,
        Markdown, plain text, CSV/TSV, PDF, DOCX, BibTeX, SRT/WebVTT subtitles, RSS/Atom feeds, XML sitemaps,
        and OmniResearch portable bundles (.omni.json). Everything is treated as untrusted — parsed,
        size-capped, signature-checked, and previewed before anything is committed.
      </p>

      {!preview && !result && (
        <div className="panel mt-4 space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label">Type</label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Or pick a file (.md .txt .csv .tsv .pdf .docx .bib .srt .vtt .json)</label>
              <input
                type="file"
                accept=".md,.markdown,.txt,.csv,.tsv,.pdf,.docx,.bib,.bibtex,.srt,.vtt,.json"
                className="text-sm"
                aria-label="Import file"
                onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])}
              />
            </div>
            {filename && <span className="badge">{filename}</span>}
          </div>
          <textarea
            className="textarea font-mono text-sm"
            rows={10}
            placeholder={"Paste text, Markdown, CSV — or one URL per line…"}
            value={content}
            aria-label="Import content"
            onChange={(e) => setContent(e.target.value)}
          />
          {error && <p className="text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
          <button className="btn btn-primary" disabled={busy || (!content.trim() && !contentBase64)} onClick={buildPreview}>
            {busy ? "Parsing…" : "Parse & preview"}
          </button>
        </div>
      )}

      {preview && (
        <div className="panel mt-4 space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-bold">Preview</h2>
            <span className="badge badge-accent">{preview.preview.kind}</span>
            {preview.duplicateOfJobId && <span className="badge badge-warn">identical payload was imported before — confirming again is safe (idempotent)</span>}
          </div>
          {(preview.preview.warnings ?? []).map((w: string, i: number) => (
            <p key={i} className="text-xs" style={{ color: "var(--warn)" }}>⚠ {w}</p>
          ))}
          <div className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {preview.preview.items.map((item: any) => (
              <p key={item.index} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{item.title}</span>
                <span style={{ color: "var(--muted)" }}>{item.detail}</span>
                {item.warning && <span className="badge badge-bad">{item.warning}</span>}
              </p>
            ))}
          </div>
          {preview.preview.stats?.columns && (
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left">
                <thead><tr style={{ color: "var(--muted)" }}><th className="pr-3">Column</th><th className="pr-3">Inferred type</th><th>Missing values</th></tr></thead>
                <tbody>
                  {preview.preview.stats.columns.map((c: any) => (
                    <tr key={c.name} className="border-t" style={{ borderColor: "var(--line)" }}>
                      <td className="pr-3 font-mono">{c.name}</td><td className="pr-3">{c.inferredType}</td><td>{c.missing}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && <p className="text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={confirm}>{busy ? "Importing…" : "Confirm import"}</button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                await apiPost(`/api/imports/${preview.jobId}/cancel`, {}).catch(() => undefined);
                setPreview(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="panel mt-4 space-y-2 p-4">
          <h2 className="font-bold">
            Import {result.job.status === "completed" ? "complete" : result.job.status.replace(/-/g, " ")}
          </h2>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {result.counts.imported} imported · {result.counts.skipped} skipped · {result.counts.failed} failed
          </p>
          <div className="space-y-1 text-sm">
            {(result.job.items ?? []).map((item: any) => (
              <p key={item.id} className="flex flex-wrap items-center gap-2">
                <span className={`badge ${item.status === "imported" ? "badge-good" : item.status === "failed" ? "badge-bad" : "badge-warn"}`}>{item.status}</span>
                <span className="font-semibold">{item.title}</span>
                <span style={{ color: "var(--muted)" }}>{item.detail}</span>
              </p>
            ))}
          </div>
          <div className="flex gap-2">
            <Link href={`/projects/${id}/sources`} className="btn btn-primary">Open source library</Link>
            <button className="btn" onClick={() => setResult(null)}>Import more</button>
          </div>
        </div>
      )}

      {(jobsData?.jobs ?? []).length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>Recent imports</h2>
          <div className="space-y-1 text-sm">
            {jobsData!.jobs.map((job) => (
              <p key={job.id} className="panel flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="badge">{job.kind}</span>
                <span className={`badge ${job.status.startsWith("completed") ? "badge-good" : job.status === "failed" ? "badge-bad" : "badge-warn"}`}>{job.status}</span>
                <span>{job.filename ?? "(pasted)"}</span>
                <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                  {Math.round(job.byteSize / 1024)} KB · {new Date(job.createdAt).toLocaleString()}
                </span>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
