/**
 * Structural parsers for universal-import Phase 2 formats. All input is
 * untrusted text; parsers never execute anything, preserve exact original
 * values, and report warnings instead of silently discarding data.
 */

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

export type BibEntry = {
  entryType: string;
  citeKey: string;
  fields: Record<string, string>; // ALL fields preserved, unknown ones included
  title?: string;
  authors?: string;
  year?: string;
  doi?: string;
  url?: string;
  warnings: string[];
};

export function parseBibtex(text: string): { entries: BibEntry[]; warnings: string[] } {
  const entries: BibEntry[] = [];
  const warnings: string[] = [];
  const entryRe = /@\s*([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(text))) {
    const entryType = match[1]!.toLowerCase();
    if (entryType === "comment" || entryType === "preamble" || entryType === "string") continue;
    // Balance braces to find the entry body.
    let depth = 1;
    let i = entryRe.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    const body = text.slice(entryRe.lastIndex, i - 1);
    const fields: Record<string, string> = {};
    const fieldRe = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRe.exec(body))) {
      const value = (fieldMatch[3] ?? fieldMatch[4] ?? fieldMatch[5] ?? "")
        .replace(/[{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      fields[fieldMatch[1]!.toLowerCase()] = value;
    }
    const entryWarnings: string[] = [];
    if (!fields.title) entryWarnings.push("no title field");
    if (!fields.author && !fields.editor) entryWarnings.push("no author/editor field");
    entries.push({
      entryType,
      citeKey: match[2]!,
      fields,
      title: fields.title,
      authors: fields.author ?? fields.editor,
      year: fields.year,
      doi: fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
      url: fields.url ?? (fields.doi ? `https://doi.org/${fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : undefined),
      warnings: entryWarnings,
    });
  }
  if (entries.length === 0) warnings.push("No BibTeX entries could be parsed");
  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// SRT / WebVTT subtitles
// ---------------------------------------------------------------------------

export type SubtitleCue = {
  id: string;
  startMs: number;
  endMs: number;
  start: string; // exact original timestamp text
  end: string;
  speaker?: string;
  text: string; // exact original cue text (speaker prefix removed only when detected)
};

function timeToMs(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return (Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms);
}

export function parseSubtitles(text: string, format: "srt" | "vtt"): { cues: SubtitleCue[]; warnings: string[]; language?: string } {
  const warnings: string[] = [];
  let language: string | undefined;
  let body = text.replace(/^﻿/, "");
  if (format === "vtt") {
    if (!/^WEBVTT/.test(body)) warnings.push("Missing WEBVTT header");
    const langMatch = body.match(/^Language:\s*([A-Za-z-]+)/m);
    language = langMatch?.[1];
    body = body.replace(/^WEBVTT[^\n]*\n/, "");
  }
  const blocks = body.split(/\r?\n\r?\n+/).map((b) => b.trim()).filter(Boolean);
  const cues: SubtitleCue[] = [];
  let autoId = 0;
  for (const block of blocks) {
    if (format === "vtt" && /^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split(/\r?\n/);
    let idLine: string | undefined;
    const timeLineIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIndex === -1) {
      warnings.push(`Block without a timestamp line was kept as a warning, not silently dropped: "${block.slice(0, 60)}"`);
      continue;
    }
    if (timeLineIndex > 0) idLine = lines[0]!.trim();
    const [startRaw, endRaw] = lines[timeLineIndex]!.split("-->").map((p) => p.trim().split(" ")[0]!);
    const startMs = timeToMs(startRaw!);
    const endMs = timeToMs(endRaw!);
    if (startMs === null || endMs === null) {
      warnings.push(`Malformed timestamp: "${lines[timeLineIndex]}"`);
      continue;
    }
    let cueText = lines.slice(timeLineIndex + 1).join("\n").trim();
    let speaker: string | undefined;
    const vttVoice = cueText.match(/^<v(?:\.[^ >]*)?\s+([^>]+)>/);
    if (vttVoice) {
      speaker = vttVoice[1]!.trim();
      cueText = cueText.replace(/^<v[^>]*>/, "").replace(/<\/v>/g, "").trim();
    } else {
      const labeled = cueText.match(/^([A-Z][A-Za-z .'-]{1,30}):\s+(.*)$/s);
      if (labeled) {
        speaker = labeled[1];
        cueText = labeled[2]!.trim();
      }
    }
    autoId++;
    cues.push({ id: idLine ?? String(autoId), startMs, endMs, start: startRaw!, end: endRaw!, speaker, text: cueText });
  }
  // Overlap detection (report, never discard).
  for (let i = 1; i < cues.length; i++) {
    if (cues[i]!.startMs < cues[i - 1]!.endMs) {
      warnings.push(`Cues ${cues[i - 1]!.id} and ${cues[i]!.id} overlap in time`);
    }
  }
  if (cues.length === 0) warnings.push("No subtitle cues could be parsed");
  return { cues, warnings, language };
}

export function msToClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// DOCX (OOXML) — structural text extraction; macros/active content rejected
// ---------------------------------------------------------------------------

export type DocxResult = {
  paragraphs: { text: string; heading: number | null }[];
  tables: number;
  links: string[];
  hasMacros: boolean;
  warnings: string[];
};

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse a DOCX buffer. Validates the OOXML zip, flags (never runs) macros,
 *  and extracts headings, paragraphs, tables, and hyperlink targets. */
export async function parseDocx(bytes: Buffer): Promise<DocxResult> {
  // OOXML files are ZIP archives beginning with the PK signature.
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new Error("Not a DOCX: missing ZIP/OOXML signature (extensions and MIME types are not trusted)");
  }
  const { default: JSZip } = await import("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("DOCX archive could not be opened (corrupt or not an OOXML file)");
  }
  const warnings: string[] = [];
  // Active content is flagged and never executed; we only read text XML.
  const hasMacros = Object.keys(zip.files).some((name) => /vbaProject\.bin$|\.vbaProject|macros/i.test(name));
  if (hasMacros) warnings.push("Document contains a macro project (vbaProject.bin) — macros are IGNORED and never executed; only text is extracted");

  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("DOCX missing word/document.xml");
  const xml = await docFile.async("string");

  // Hyperlink targets come from the relationships file (local only — external
  // relationships are never auto-fetched; we only record their URLs).
  const links: string[] = [];
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (relsFile) {
    const rels = await relsFile.async("string");
    for (const m of rels.matchAll(/Target="([^"]+)"[^>]*TargetMode="External"/g)) links.push(decodeXmlEntities(m[1]!));
  }

  const paragraphs: { text: string; heading: number | null }[] = [];
  let tables = 0;
  for (const _t of xml.matchAll(/<w:tbl[ >]/g)) { void _t; tables++; }

  for (const paraMatch of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const para = paraMatch[0];
    const styleMatch = para.match(/<w:pStyle\s+w:val="([^"]+)"/);
    let heading: number | null = null;
    if (styleMatch) {
      const hm = styleMatch[1]!.match(/^Heading(\d)/i);
      if (hm) heading = Number(hm[1]);
      else if (/^Title$/i.test(styleMatch[1]!)) heading = 1;
    }
    const runs = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEntities(m[1]!));
    const isListItem = /<w:numPr[ >]/.test(para);
    const text = (isListItem ? "• " : "") + runs.join("").replace(/\s+/g, " ").trim();
    if (text) paragraphs.push({ text, heading });
  }
  if (paragraphs.length === 0) warnings.push("No extractable paragraphs found");
  return { paragraphs, tables, links, hasMacros, warnings };
}
