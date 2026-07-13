"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";

const TYPES = ["", "run-started", "run-completed", "run-failed", "source-added", "note-created", "claim-created", "report-generated", "export-created", "story-generated", "import-completed", "import-failed"];

const ICON: Record<string, string> = {
  "run-started": "▶", "run-completed": "✓", "run-failed": "✕", "source-added": "🔗",
  "note-created": "✎", "claim-created": "❝", "report-generated": "📄", "export-created": "⇩",
  "story-generated": "🎬", "import-completed": "⇪", "import-failed": "⚠", "project-created": "★",
};

function eventHref(projectId: string, event: any): string | null {
  switch (event.entityType) {
    case "run": return `/runs/${event.entityId}`;
    case "report": return `/projects/${projectId}/report`;
    case "note": return `/projects/${projectId}/notebook`;
    case "source": return `/projects/${projectId}/sources`;
    case "claim": return `/projects/${projectId}/report?tab=claims`;
    case "story": return `/projects/${projectId}/story`;
    case "import": return `/projects/${projectId}/import`;
    default: return null;
  }
}

export default function TimelinePage() {
  const { id } = useParams<{ id: string }>();
  const [type, setType] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [pages, setPages] = useState<any[][]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ["timeline", id, type, before],
    queryFn: () =>
      apiGet<{ events: any[]; hasMore: boolean; nextBefore: string | null }>(
        `/api/projects/${id}/timeline?${new URLSearchParams({ ...(type ? { type } : {}), ...(before ? { before } : {}), limit: "50" })}`
      ),
  });
  const events = [...pages.flat(), ...(data?.events ?? [])];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Timeline</h1>
        <select
          className="select w-auto"
          value={type}
          aria-label="Filter by event type"
          onChange={(e) => { setType(e.target.value); setBefore(null); setPages([]); }}
        >
          {TYPES.map((t) => <option key={t} value={t}>{t || "all events"}</option>)}
        </select>
        <Link href={`/projects/${id}`} className="btn ml-auto">Project</Link>
      </div>

      {isLoading && events.length === 0 && <div className="skeleton mt-4 h-32" />}
      <ol className="mt-4 space-y-1">
        {events.map((event) => {
          const href = eventHref(id, event);
          const body = (
            <span className="flex flex-wrap items-center gap-2">
              <span aria-hidden>{ICON[event.type] ?? "•"}</span>
              <span className="badge">{event.type}</span>
              <span className={`badge ${event.actor === "system" ? "" : "badge-accent"}`}>{event.actor}</span>
              <span className="text-sm">{event.summary}</span>
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>{new Date(event.createdAt).toLocaleString()}</span>
            </span>
          );
          return (
            <li key={event.id} className="panel px-3 py-2">
              {href ? <Link href={href} className="block hover:opacity-80">{body}</Link> : body}
            </li>
          );
        })}
        {events.length === 0 && !isLoading && (
          <p className="p-8 text-center text-sm" style={{ color: "var(--muted)" }}>
            No events yet. Runs, imports, notes, reports, and exports appear here as they happen.
          </p>
        )}
      </ol>
      {data?.hasMore && (
        <button
          className="btn mt-3"
          onClick={() => {
            setPages((p) => [...p, data.events]);
            setBefore(data.nextBefore);
          }}
        >
          Load older events
        </button>
      )}
    </div>
  );
}
