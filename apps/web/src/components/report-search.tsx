"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * In-report search bar. The report page passes the query down into every
 * Markdown block (which wraps matches in <mark data-search-mark>); this
 * component owns the query, the match count, and next/previous navigation by
 * walking the rendered marks inside `containerRef`.
 *
 * Cmd/Ctrl+F opens it (replacing browser find inside the report), Enter /
 * Shift+Enter navigate, Esc closes.
 */
export function ReportSearchBar({
  containerRef,
  query,
  onQueryChange,
  initialOpen = false,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  query: string;
  onQueryChange: (q: string) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen || Boolean(query));
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const marks = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return [];
    return [...containerRef.current.querySelectorAll<HTMLElement>("mark[data-search-mark]")];
  }, [containerRef]);

  // Recount matches after every query change (post-render).
  useEffect(() => {
    if (!query.trim()) {
      setMatchCount(0);
      setActiveIndex(0);
      return;
    }
    const id = window.setTimeout(() => {
      const found = marks();
      setMatchCount(found.length);
      setActiveIndex((current) => Math.min(current, Math.max(0, found.length - 1)));
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, marks]);

  // Style + scroll the active match.
  useEffect(() => {
    const found = marks();
    found.forEach((el, i) => el.classList.toggle("active", i === activeIndex));
    const active = found[activeIndex];
    if (active) active.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, matchCount, marks]);

  const goto = useCallback(
    (delta: number) => {
      if (matchCount === 0) return;
      setActiveIndex((current) => (current + delta + matchCount) % matchCount);
    },
    [matchCount]
  );

  // Cmd/Ctrl+F opens the in-report search instead of browser find.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setOpen(true);
        window.setTimeout(() => inputRef.current?.select(), 20);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button className="btn" title="Search in report (Ctrl/Cmd+F)" onClick={() => setOpen(true)}>
        Find
      </button>
    );
  }

  return (
    <div
      className="panel flex items-center gap-2 px-3 py-1.5"
      role="search"
      aria-label="Search within report"
    >
      <input
        ref={inputRef}
        className="w-44 bg-transparent text-sm outline-none"
        placeholder="Find in report…"
        value={query}
        aria-label="Find in report"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            goto(e.shiftKey ? -1 : 1);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onQueryChange("");
            setOpen(false);
          }
        }}
      />
      <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }} aria-live="polite">
        {query.trim().length >= 2 ? (matchCount > 0 ? `${activeIndex + 1} of ${matchCount}` : "0 matches") : ""}
      </span>
      <button className="btn px-2 py-1" aria-label="Previous match" title="Previous (Shift+Enter)" onClick={() => goto(-1)} disabled={matchCount === 0}>
        ↑
      </button>
      <button className="btn px-2 py-1" aria-label="Next match" title="Next (Enter)" onClick={() => goto(1)} disabled={matchCount === 0}>
        ↓
      </button>
      <button
        className="btn px-2 py-1"
        aria-label="Close search"
        onClick={() => {
          onQueryChange("");
          setOpen(false);
        }}
      >
        ✕
      </button>
    </div>
  );
}
