"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { segmentsFromServerSnippet } from "@/lib/search-highlight";
import type { SearchHit } from "@omni/shared";

const TYPE_LABEL: Record<string, string> = {
  report: "Report",
  evidence: "Evidence",
  source: "Source",
  claim: "Claim",
  citation: "Citation",
  project: "Project",
  note: "Note",
};

export function hitHref(hit: SearchHit): string {
  switch (hit.type) {
    case "report":
    case "citation":
      return `/projects/${hit.projectId}/report?find=${encodeURIComponent(firstMatchedWord(hit.snippet))}`;
    case "evidence":
      return `/projects/${hit.projectId}/report?tab=evidence`;
    case "claim":
      return `/projects/${hit.projectId}/report?tab=fact-check`;
    case "source":
      return `/projects/${hit.projectId}/sources?q=${encodeURIComponent(hit.title.slice(0, 60))}`;
    case "note":
    case "project":
    default:
      return `/projects/${hit.projectId}`;
  }
}

function firstMatchedWord(snippet: string): string {
  const match = snippet.match(/\[\[(.+?)\]\]/);
  return match?.[1]?.slice(0, 60) ?? "";
}

export function Snippet({ text }: { text: string }) {
  const segments = segmentsFromServerSnippet(text);
  return (
    <span>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className="search-mark">{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </span>
  );
}

/**
 * Global search palette: Cmd/Ctrl+K anywhere. Debounced cross-project search
 * over the /api/search endpoint; Enter opens the selected hit; the footer
 * links to the full /search page with filters.
 */
export function GlobalSearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(id);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ["global-search", debounced],
    queryFn: () => apiGet<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(debounced)}&limit=20`),
    enabled: open && debounced.trim().length >= 2,
    staleTime: 30_000,
  });
  const hits = data?.hits ?? [];

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((o) => !o);
        window.setTimeout(() => inputRef.current?.focus(), 20);
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => setSelected(0), [hits.length, debounced]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Global search"
    >
      <div className="panel w-full max-w-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
          <span aria-hidden>🔍</span>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm outline-none"
            placeholder="Search claims, evidence, reports, sources, notes… (Esc to close)"
            value={query}
            aria-label="Search across all projects"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(s + 1, hits.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(s - 1, 0));
              }
              if (e.key === "Enter" && hits[selected]) {
                e.preventDefault();
                router.push(hitHref(hits[selected]!));
                close();
              }
            }}
          />
          {isFetching && <span className="text-xs" style={{ color: "var(--muted)" }}>searching…</span>}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {debounced.trim().length >= 2 && hits.length === 0 && !isFetching && (
            <p className="px-4 py-6 text-center text-sm" style={{ color: "var(--muted)" }}>
              No matches across your projects.
            </p>
          )}
          {hits.map((hit, index) => (
            <button
              key={`${hit.type}-${hit.entityId}`}
              type="button"
              className="block w-full border-b px-4 py-2.5 text-left text-sm hover:opacity-80"
              style={{
                borderColor: "var(--line)",
                background: index === selected ? "color-mix(in srgb, var(--accent) 10%, transparent)" : undefined,
              }}
              onMouseEnter={() => setSelected(index)}
              onClick={() => {
                router.push(hitHref(hit));
                close();
              }}
            >
              <span className="flex items-center gap-2">
                <span className="badge">{TYPE_LABEL[hit.type] ?? hit.type}</span>
                <span className="truncate font-semibold">{hit.title}</span>
                <span className="ml-auto shrink-0 text-xs" style={{ color: "var(--muted)" }}>
                  {hit.projectTitle}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs" style={{ color: "var(--muted)" }}>
                <Snippet text={hit.snippet} />
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 text-xs" style={{ color: "var(--muted)" }}>
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
          <Link href={`/search?q=${encodeURIComponent(query)}`} className="ml-auto underline" onClick={close}>
            Full search with filters →
          </Link>
        </div>
      </div>
    </div>
  );
}
