/**
 * Pure text-search helpers for in-report search and snippet rendering.
 * Kept free of React so they are unit-testable.
 */

export type HighlightSegment = { text: string; match: boolean };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive matcher for a user query (whole phrase, trimmed). */
export function buildMatcher(query: string): RegExp | null {
  const trimmed = query.trim();
  if (trimmed.length < 2) return null;
  return new RegExp(escapeRegExp(trimmed), "gi");
}

/** Split text into match / non-match segments for <mark> rendering. */
export function splitForHighlight(text: string, query: string): HighlightSegment[] {
  const matcher = buildMatcher(query);
  if (!matcher || !text) return [{ text, match: false }];
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), match: false });
    segments.push({ text: match[0], match: true });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/** Count matches of the query in a block of text. */
export function countMatches(text: string, query: string): number {
  const matcher = buildMatcher(query);
  if (!matcher || !text) return 0;
  return [...text.matchAll(matcher)].length;
}

/**
 * Convert a server snippet using [[ ]] delimiters (ts_headline) into
 * highlight segments. The snippet is plain text — never HTML.
 */
export function segmentsFromServerSnippet(snippet: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const parts = snippet.split(/(\[\[|\]\])/);
  let inMatch = false;
  for (const part of parts) {
    if (part === "[[") {
      inMatch = true;
      continue;
    }
    if (part === "]]") {
      inMatch = false;
      continue;
    }
    if (part) segments.push({ text: part, match: inMatch });
  }
  return segments;
}
