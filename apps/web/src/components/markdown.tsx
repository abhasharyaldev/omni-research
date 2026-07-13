"use client";

import ReactMarkdown from "react-markdown";
import { useState } from "react";
import { splitForHighlight } from "@/lib/search-highlight";

/**
 * Safe Markdown rendering: react-markdown does not render raw HTML by
 * default, so crawled/model content cannot inject markup. Citation markers
 * like [3] become clickable chips that open the source drawer; when a search
 * query is active, matches are wrapped in <mark data-search-mark>.
 */
export function Markdown({
  content,
  onCitationClick,
  highlight,
}: {
  content: string;
  onCitationClick?: (marker: number) => void;
  highlight?: string;
}) {
  const renderPlain = (text: string, keyPrefix: string) => {
    if (!highlight || highlight.trim().length < 2) return text;
    const segments = splitForHighlight(text, highlight);
    if (segments.length === 1 && !segments[0]!.match) return text;
    return segments.map((segment, index) =>
      segment.match ? (
        <mark key={`${keyPrefix}-${index}`} data-search-mark className="search-mark">
          {segment.text}
        </mark>
      ) : (
        <span key={`${keyPrefix}-${index}`}>{segment.text}</span>
      )
    );
  };

  // Split out [n] markers so they render as interactive elements; search
  // highlighting applies only to the plain text between markers, so citation
  // links keep working while a search is active.
  const renderWithCitations = (text: string, keyPrefix: string) => {
    if (!onCitationClick) return renderPlain(text, keyPrefix);
    const parts = text.split(/(\[\d{1,3}\])/g);
    return parts.map((part, index) => {
      const match = part.match(/^\[(\d{1,3})\]$/);
      if (match) {
        const marker = Number(match[1]);
        return (
          <button
            key={`${keyPrefix}-c${index}`}
            type="button"
            className="citation-marker"
            title={`Open source [${marker}]`}
            onClick={() => onCitationClick(marker)}
          >
            [{marker}]
          </button>
        );
      }
      return <span key={`${keyPrefix}-t${index}`}>{renderPlain(part, `${keyPrefix}-${index}`)}</span>;
    });
  };

  return (
    <div className="prose-omni">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          p: ({ children }) => <p>{walk(children)}</p>,
          li: ({ children }) => <li>{walk(children)}</li>,
          h1: ({ children }) => <h1>{walk(children)}</h1>,
          h2: ({ children }) => <h2>{walk(children)}</h2>,
          h3: ({ children }) => <h3>{walk(children)}</h3>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );

  function walk(children: React.ReactNode): React.ReactNode {
    if (typeof children === "string") return renderWithCitations(children, "s");
    if (Array.isArray(children)) {
      return children.map((child, i) =>
        typeof child === "string" ? <span key={i}>{renderWithCitations(child, `a${i}`)}</span> : child
      );
    }
    return children;
  }
}

export function CollapsibleCard({ title, children, badge }: { title: string; children: React.ReactNode; badge?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left font-semibold"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{title}</span>
        <span className="flex items-center gap-2">{badge}<span style={{ color: "var(--muted)" }}>{open ? "−" : "+"}</span></span>
      </button>
      {open && <div className="border-t px-4 py-3" style={{ borderColor: "var(--line)" }}>{children}</div>}
    </div>
  );
}
