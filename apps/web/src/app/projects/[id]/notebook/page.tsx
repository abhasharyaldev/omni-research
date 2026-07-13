"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPatch, apiDelete, ApiError } from "@/lib/api";

type SaveState = "idle" | "saving" | "saved" | "failed" | "offline";

/**
 * Research notebook: notes with tags, pinning, archiving, entity links, and
 * reliable debounced autosave with a visible saving/saved/failed indicator.
 */
export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; contentMd: string; tags: string }>({ title: "", contentMd: "", tags: "" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<number | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  const { data, isLoading } = useQuery({
    queryKey: ["notes", id, q, tag, showArchived],
    queryFn: () =>
      apiGet<{ notes: any[] }>(
        `/api/projects/${id}/notes?${new URLSearchParams({ ...(q ? { q } : {}), ...(tag ? { tag } : {}), archived: showArchived ? "1" : "0" })}`
      ),
  });
  const notes = data?.notes ?? [];
  const active = notes.find((n) => n.id === activeId);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["notes", id] });

  const openNote = (note: any) => {
    // Flush any pending save of the previous note first (never lose writing).
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      void persist();
    }
    setActiveId(note.id);
    setDraft({ title: note.title ?? "", contentMd: note.contentMd, tags: (note.tags ?? []).join(", ") });
    setSaveState("idle");
  };

  const persist = useCallback(async () => {
    if (!activeId) return;
    const current = latestDraft.current;
    setSaveState("saving");
    try {
      await apiPatch(`/api/notes/${activeId}`, {
        title: current.title || undefined,
        contentMd: current.contentMd,
        tags: current.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 20),
      });
      setSaveState("saved");
      void invalidate();
    } catch {
      setSaveState(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "failed");
    }
  }, [activeId]);

  const scheduleSave = (next: typeof draft) => {
    setDraft(next);
    setSaveState("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(), 900);
  };

  // Flush pending save on unmount/navigation.
  useEffect(() => () => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      void persist();
    }
  }, [persist]);

  const createNote = async () => {
    const { note } = await apiPost<{ note: any }>(`/api/projects/${id}/notes`, { contentMd: "" });
    await invalidate();
    openNote(note);
  };

  const mutate = async (noteId: string, patch: object) => {
    await apiPatch(`/api/notes/${noteId}`, patch);
    await invalidate();
  };

  const SAVE_LABEL: Record<SaveState, string> = {
    idle: "",
    saving: "Saving…",
    saved: "Saved",
    failed: "Save failed — retrying on next edit",
    offline: "Offline — will save when reconnected",
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Notebook</h1>
        <button className="btn btn-primary" onClick={createNote}>New note</button>
        <Link href={`/projects/${id}`} className="btn ml-auto">Project</Link>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="panel flex flex-wrap items-end gap-2 p-3">
            <input className="input min-w-32 flex-1" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
            <input className="input w-28" placeholder="tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag" />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived</label>
          </div>
          {isLoading && <div className="skeleton mt-2 h-24" />}
          <div className="mt-2 space-y-1">
            {notes.map((note) => (
              <button
                key={note.id}
                className="panel block w-full px-3 py-2 text-left text-sm hover:opacity-80"
                style={activeId === note.id ? { borderColor: "var(--accent)" } : undefined}
                onClick={() => openNote(note)}
              >
                <span className="flex items-center gap-1">
                  {note.pinned && <span title="Pinned">📌</span>}
                  <span className="truncate font-semibold">{note.title || note.contentMd.slice(0, 50) || "(untitled)"}</span>
                  <span className="ml-auto shrink-0 text-xs" style={{ color: "var(--muted)" }}>{new Date(note.updatedAt).toLocaleDateString()}</span>
                </span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {(note.tags ?? []).map((t: string) => <span key={t} className="badge">{t}</span>)}
                  {note.source && <span className="badge badge-accent">source</span>}
                  {note.claim && <span className="badge badge-warn">claim</span>}
                  {note.evidence && <span className="badge">evidence</span>}
                  {note.report && <span className="badge">report</span>}
                  {note.quotedText && <span className="badge">quote</span>}
                </span>
              </button>
            ))}
            {notes.length === 0 && !isLoading && (
              <p className="p-6 text-center text-sm" style={{ color: "var(--muted)" }}>
                No notes yet. Notes can link to sources, claims, evidence, and reports.
              </p>
            )}
          </div>
        </div>

        <div className="lg:col-span-3">
          {!active && <div className="panel p-8 text-center text-sm" style={{ color: "var(--muted)" }}>Select or create a note.</div>}
          {active && (
            <div className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input flex-1 text-base font-semibold"
                  placeholder="Note title"
                  value={draft.title}
                  aria-label="Note title"
                  onChange={(e) => scheduleSave({ ...draft, title: e.target.value })}
                />
                <span className="text-xs" aria-live="polite" style={{ color: saveState === "failed" || saveState === "offline" ? "var(--bad)" : "var(--muted)" }}>
                  {SAVE_LABEL[saveState]}
                </span>
              </div>
              <textarea
                className="textarea mt-2 font-mono text-sm"
                rows={14}
                placeholder="Write in Markdown…"
                value={draft.contentMd}
                aria-label="Note content"
                onChange={(e) => scheduleSave({ ...draft, contentMd: e.target.value })}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="input w-64"
                  placeholder="tags, comma separated"
                  value={draft.tags}
                  aria-label="Tags"
                  onChange={(e) => scheduleSave({ ...draft, tags: e.target.value })}
                />
                <button className="btn" onClick={() => mutate(active.id, { pinned: !active.pinned })}>{active.pinned ? "Unpin" : "Pin"}</button>
                <button className="btn" onClick={() => { void mutate(active.id, { archived: !active.archived }); setActiveId(null); }}>
                  {active.archived ? "Unarchive" : "Archive"}
                </button>
                <button
                  className="btn"
                  title="Create a claim in the ledger from this note"
                  onClick={async () => {
                    try {
                      await apiPost(`/api/notes/${active.id}/promote-to-claim`);
                      await invalidate();
                    } catch (err) {
                      alert(err instanceof ApiError ? err.message : "Failed");
                    }
                  }}
                >
                  Promote to claim
                </button>
                <button
                  className="btn btn-danger ml-auto"
                  onClick={async () => {
                    if (!confirm("Delete this note permanently?")) return;
                    await apiDelete(`/api/notes/${active.id}`);
                    setActiveId(null);
                    await invalidate();
                  }}
                >
                  Delete
                </button>
              </div>
              {active.quotedText && (
                <blockquote className="mt-3 border-l-2 pl-3 text-sm" style={{ borderColor: "var(--accent)", color: "var(--muted)" }}>
                  “{active.quotedText}” {active.sourceLocation && <em>({active.sourceLocation})</em>}
                </blockquote>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-xs" style={{ color: "var(--muted)" }}>
                {active.source && <Link className="underline" href={`/projects/${id}/sources`}>linked source: {active.source.title ?? active.source.url}</Link>}
                {active.claim && <Link className="underline" href={`/projects/${id}/report?tab=claims`}>linked claim: {active.claim.text.slice(0, 60)}</Link>}
                {active.report && <Link className="underline" href={`/projects/${id}/report`}>linked report</Link>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
