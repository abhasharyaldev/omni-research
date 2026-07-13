/** Sentence splitting tuned for citation-grade excerpts. */
export function splitSentences(text: string, options: { maxSentences?: number; maxChars?: number } = {}): string[] {
  const maxSentences = options.maxSentences ?? 80;
  const maxChars = options.maxChars ?? 400;
  const sentences: string[] = [];
  // Split on sentence-ending punctuation followed by whitespace + capital/open quote,
  // and on newlines (headings, list items).
  const rough = text
    .split(/\n+/)
    .flatMap((block) => block.split(/(?<=[.!?])\s+(?=["'“(]?[A-Z0-9])/));
  for (const raw of rough) {
    const sentence = raw.replace(/\s+/g, " ").trim();
    if (sentence.length < 20 || sentence.length > maxChars) continue;
    if (!/[a-zA-Z]{3}/.test(sentence)) continue;
    sentences.push(sentence);
    if (sentences.length >= maxSentences) break;
  }
  return sentences;
}

/** Locate an excerpt inside source text; returns a human-readable locator. */
export function locateExcerpt(sourceText: string, excerpt: string): string | undefined {
  const index = sourceText.indexOf(excerpt);
  if (index === -1) return undefined;
  const before = sourceText.slice(0, index);
  const paragraph = before.split("\n").length;
  return `paragraph ${paragraph}`;
}

/** Whitespace-tolerant substring check (source of truth for citation verification). */
export function containsVerbatim(haystack: string, needle: string): boolean {
  if (!needle.trim()) return false;
  const normalize = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(haystack).includes(normalize(needle));
}
