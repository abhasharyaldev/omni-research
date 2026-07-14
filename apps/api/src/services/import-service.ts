import { createHash } from "node:crypto";
import { getPrisma, recordTimelineEvent } from "@omni/database";
import { newId, sha256Hex } from "@omni/shared";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  escapeSpreadsheetCell,
  parseDelimited,
  rejectNonText,
  sanitizeFilename,
  validateUrlSyntax,
} from "@omni/security";
import { extractPdfFromBytes, fetchFeed, fetchSitemap, normalizeUrl } from "@omni/crawler";
import { parseBibtex, parseDocx, parseSubtitles, msToClock } from "./import-formats.js";
import { previewBundle, importBundle, BUNDLE_MARKER } from "./bundle-service.js";

/**
 * Universal import v1 (text formats). Flow: parse → preview (stored on the
 * job) → user confirms → commit creates Sources/snapshots with full
 * provenance. Every payload is untrusted: size caps, binary-signature
 * rejection, filename sanitization, SSRF-safe URL validation, spreadsheet
 * formula escaping, checksum idempotency, content-hash dedup.
 */

export const IMPORT_KINDS = ["pasted-text", "url-list", "markdown", "plain-text", "csv", "tsv", "pdf", "docx", "bibtex", "srt", "vtt", "rss", "atom", "sitemap", "omni-bundle"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export type ImportPreview = {
  kind: ImportKind;
  items: { index: number; title: string; detail: string; warning?: string }[];
  warnings: string[];
  stats?: Record<string, unknown>;
};

export function detectKind(filename: string | undefined, content: string): ImportKind {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt") return "plain-text";
  if (ext === "bib" || ext === "bibtex") return "bibtex";
  if (ext === "srt") return "srt";
  if (ext === "vtt") return "vtt";
  if (content.trimStart().startsWith("WEBVTT")) return "vtt";
  if (content.includes(BUNDLE_MARKER)) return "omni-bundle";
  if (/^@\s*[a-zA-Z]+\s*\{/m.test(content.trimStart().slice(0, 200))) return "bibtex";
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^https?:\/\//i.test(l.trim()))) return "url-list";
  return "pasted-text";
}

export async function buildPreview(kind: ImportKind, content: string, filename?: string, binary?: Buffer): Promise<ImportPreview> {
  const warnings: string[] = [];
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(`Import exceeds the ${Math.round(MAX_IMPORT_BYTES / 1_048_576)} MB limit`);
  }
  if (kind === "pdf") {
    if (!binary) throw new Error("PDF import requires the file payload (contentBase64)");
    const pdf = await extractPdfFromBytes(binary);
    if (pdf.encrypted) warnings.push("PDF is encrypted — no text extracted");
    warnings.push(...pdf.warnings);
    return {
      kind,
      items: [{
        index: 0,
        title: pdf.title ?? sanitizeFilename(filename ?? "document.pdf"),
        detail: `${pdf.pageTexts.length} page(s), ${pdf.pageTexts.join("").length} extracted characters${pdf.author ? `, by ${pdf.author}` : ""}`,
        warning: pdf.encrypted ? "encrypted" : pdf.imageOnly ? "image-only (OCR needed, not performed)" : undefined,
      }],
      warnings,
      stats: { pages: pdf.pageTexts.length, encrypted: pdf.encrypted, imageOnly: pdf.imageOnly, title: pdf.title, author: pdf.author, publishedAt: pdf.publishedAt?.toISOString() },
    };
  }

  if (kind === "docx") {
    if (!binary) throw new Error("DOCX import requires the file payload (contentBase64)");
    const doc = await parseDocx(binary);
    warnings.push(...doc.warnings);
    const headings = doc.paragraphs.filter((pp) => pp.heading !== null).map((pp) => pp.text);
    return {
      kind,
      items: [{
        index: 0,
        title: headings[0] ?? sanitizeFilename(filename ?? "document.docx"),
        detail: `${doc.paragraphs.length} paragraph(s), ${headings.length} heading(s), ${doc.tables} table(s), ${doc.links.length} external link(s)${doc.hasMacros ? " · macros ignored" : ""}`,
        warning: doc.hasMacros ? "contains macros (ignored, never executed)" : undefined,
      }],
      warnings,
      stats: { paragraphs: doc.paragraphs.length, headings: headings.slice(0, 20), tables: doc.tables, links: doc.links, hasMacros: doc.hasMacros },
    };
  }

  const binaryReason = rejectNonText(bytes);
  if (binaryReason) throw new Error(binaryReason);

  if (kind === "omni-bundle") {
    return previewBundle(content);
  }

  if (kind === "bibtex") {
    const parsed = parseBibtex(content);
    warnings.push(...parsed.warnings);
    if (parsed.entries.length === 0) throw new Error("No BibTeX entries could be parsed");
    if (parsed.entries.length > MAX_IMPORT_ITEMS) throw new Error(`Too many entries (max ${MAX_IMPORT_ITEMS})`);
    return {
      kind,
      items: parsed.entries.map((entry, index) => ({
        index,
        title: entry.title ?? entry.citeKey,
        detail: `${entry.entryType} · ${entry.authors ?? "authors unknown"} · ${entry.year ?? "year unknown"}${entry.doi ? ` · DOI ${entry.doi}` : ""}`,
        warning: entry.warnings.length ? entry.warnings.join("; ") : undefined,
      })),
      warnings,
      stats: { entries: parsed.entries.map((e) => ({ citeKey: e.citeKey, doi: e.doi, fieldCount: Object.keys(e.fields).length })) },
    };
  }

  if (kind === "srt" || kind === "vtt") {
    const parsed = parseSubtitles(content, kind);
    warnings.push(...parsed.warnings);
    if (parsed.cues.length === 0) throw new Error("No subtitle cues could be parsed");
    return {
      kind,
      items: [{
        index: 0,
        title: sanitizeFilename(filename ?? `subtitles.${kind}`),
        detail: `${parsed.cues.length} cue(s), ${msToClock(parsed.cues[parsed.cues.length - 1]!.endMs)} total${parsed.language ? `, language ${parsed.language}` : ""}${parsed.cues.some((c) => c.speaker) ? ", speaker labels present" : ""}`,
      }],
      warnings,
      stats: { cueCount: parsed.cues.length, language: parsed.language, speakers: [...new Set(parsed.cues.map((c) => c.speaker).filter(Boolean))].slice(0, 10) },
    };
  }

  if (kind === "rss" || kind === "atom" || kind === "sitemap") {
    // Content is one feed/sitemap URL; fetched through the full SSRF-safe
    // pipeline (DNS + connect-time checks, redirect validation, size limits).
    const url = content.trim().split(/\r?\n/)[0]!.trim();
    const check = validateUrlSyntax(url);
    if (!check.ok) throw new Error(`Feed URL blocked by safety policy: ${check.reason}`);
    const userAgent = process.env.CRAWLER_USER_AGENT || "OmniResearchBot/1.0";
    let discovered: { url: string; title: string; publishedAt?: Date }[] = [];
    if (kind === "sitemap") {
      const sitemap = await fetchSitemap(url, { userAgent, maxEntries: MAX_IMPORT_ITEMS });
      discovered = sitemap.entries.map((e) => ({ url: e.url, title: e.url, publishedAt: e.lastModified }));
      if (sitemap.childSitemaps.length > 0) warnings.push(`${sitemap.childSitemaps.length} child sitemap(s) found — import them separately (recursion is bounded)`);
    } else {
      const feed = await fetchFeed(url, { userAgent });
      discovered = feed.items.map((i) => ({ url: i.url, title: i.title, publishedAt: i.publishedAt }));
    }
    if (discovered.length === 0) throw new Error("No URLs discovered");
    const seen = new Set<string>();
    const items = [];
    for (const entry of discovered.slice(0, MAX_IMPORT_ITEMS)) {
      const normalized = normalizeUrl(entry.url);
      const urlCheck = validateUrlSyntax(entry.url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      items.push({
        index: items.length,
        title: entry.title.slice(0, 200),
        detail: `${normalized}${entry.publishedAt ? ` · ${entry.publishedAt.toISOString().slice(0, 10)}` : ""}`,
        warning: !urlCheck.ok ? `blocked: ${urlCheck.reason}` : undefined,
      });
    }
    return { kind, items, warnings, stats: { feedUrl: url, discovered: items.map((i) => i.detail.split(" ")[0]) } };
  }

  if (kind === "url-list") {
    const urls = [...new Set(content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
    if (urls.length > MAX_IMPORT_ITEMS) throw new Error(`Too many URLs (max ${MAX_IMPORT_ITEMS})`);
    const items = urls.map((url, index) => {
      const check = validateUrlSyntax(url);
      const normalized = check.ok ? normalizeUrl(url) : null;
      return {
        index,
        title: url.slice(0, 200),
        detail: normalized ? `will be added as a source (${new URL(normalized).hostname})` : "",
        warning: !check.ok ? `blocked: ${check.reason}` : !normalized ? "unparseable URL" : undefined,
      };
    });
    const blocked = items.filter((i) => i.warning).length;
    if (blocked > 0) warnings.push(`${blocked} URL(s) are blocked by safety policy and will be skipped`);
    return { kind, items, warnings };
  }

  if (kind === "csv" || kind === "tsv") {
    const rows = parseDelimited(content, kind === "csv" ? "," : "\t");
    if (rows.length === 0) throw new Error("No rows could be parsed");
    const header = rows[0]!.map((h) => escapeSpreadsheetCell(h.trim()).slice(0, 80));
    const body = rows.slice(1);
    const missingByColumn = header.map((_, c) => body.filter((r) => !(r[c] ?? "").trim()).length);
    const inferType = (c: number) => {
      const sample = body.slice(0, 50).map((r) => (r[c] ?? "").trim()).filter(Boolean);
      if (sample.length === 0) return "empty";
      if (sample.every((v) => /^-?\d+([.,]\d+)?%?$/.test(v))) return "number";
      if (sample.every((v) => !Number.isNaN(Date.parse(v)))) return "date";
      return "text";
    };
    const stats = {
      rowCount: body.length,
      columnCount: header.length,
      columns: header.map((name, c) => ({ name, inferredType: inferType(c), missing: missingByColumn[c] })),
    };
    if (body.some((r) => r.length !== header.length)) warnings.push("Some rows have a different column count than the header");
    return {
      kind,
      items: [
        {
          index: 0,
          title: sanitizeFilename(filename ?? "table"),
          detail: `${body.length} rows × ${header.length} columns: ${header.slice(0, 8).join(", ")}${header.length > 8 ? "…" : ""}`,
        },
      ],
      warnings,
      stats,
    };
  }

  // pasted-text | markdown | plain-text → one snapshot source
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) throw new Error("Content is too short to import");
  const headings = [...content.matchAll(/^#{1,3}\s+(.{2,120})$/gm)].map((m) => m[1]!.trim()).slice(0, 20);
  const title =
    headings[0] ?? content.trim().split(/\r?\n/)[0]!.slice(0, 120) ?? sanitizeFilename(filename ?? "Pasted text");
  return {
    kind,
    items: [{ index: 0, title, detail: `${wordCount} words${headings.length ? `, ${headings.length} heading(s)` : ""}` }],
    warnings,
    stats: { wordCount, headings },
  };
}

export async function createImportJob(args: {
  projectId: string;
  userId: string;
  content: string;
  contentBase64?: string; // binary payloads (PDF); capped and signature-checked
  kind?: ImportKind;
  filename?: string;
}): Promise<{ jobId: string; preview: ImportPreview; duplicateOfJobId?: string }> {
  const prisma = getPrisma();
  let binary: Buffer | undefined;
  if (args.contentBase64) {
    binary = Buffer.from(args.contentBase64, "base64");
    if (binary.length > 15 * 1024 * 1024) throw new Error("Binary import exceeds the 15 MB limit");
  }
  let detected: ImportKind | undefined = args.kind;
  if (!detected && binary) {
    if (binary.subarray(0, 5).toString("latin1").startsWith("%PDF-")) detected = "pdf";
    else if (binary[0] === 0x50 && binary[1] === 0x4b) detected = (args.filename ?? "").toLowerCase().endsWith(".docx") ? "docx" : "docx";
  }
  const kind = detected ?? detectKind(args.filename, args.content);
  const checksum = createHash("sha256").update(binary ?? args.content).digest("hex");

  // Idempotency: an identical payload already imported for this project.
  const existing = await prisma.importJob.findUnique({
    where: { projectId_checksum_kind: { projectId: args.projectId, checksum, kind } },
  });
  if (existing) {
    return { jobId: existing.id, preview: existing.previewJson as ImportPreview, duplicateOfJobId: existing.id };
  }

  const preview = await buildPreview(kind, args.content, args.filename, binary);
  const job = await prisma.importJob.create({
    data: {
      id: newId("imp"),
      projectId: args.projectId,
      userId: args.userId,
      kind,
      status: "preview-ready",
      filename: args.filename ? sanitizeFilename(args.filename) : null,
      byteSize: Buffer.byteLength(args.content),
      checksum,
      previewJson: preview as object,
      optionsJson: { content: args.content, contentBase64: args.contentBase64 }, // bounded by size caps above
    },
  });
  return { jobId: job.id, preview };
}

export class ImportAlreadyClaimedError extends Error {
  constructor(public readonly status: string) {
    super(`Import job is already ${status}`);
    this.name = "ImportAlreadyClaimedError";
  }
}

export async function confirmImportJob(jobId: string): Promise<{ imported: number; skipped: number; failed: number; idempotent?: boolean }> {
  const prisma = getPrisma();
  // ATOMIC CLAIM: exactly one request can move preview-ready -> importing.
  const claimed = await prisma.importJob.updateMany({
    where: { id: jobId, status: "preview-ready" },
    data: { status: "importing" },
  });
  if (claimed.count === 0) {
    const current = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    // Idempotent retry: a finished job returns its persisted summary.
    const summary = (current.optionsJson as { summary?: { imported: number; skipped: number; failed: number } } | null)?.summary;
    if (current.status.startsWith("completed") && summary) return { ...summary, idempotent: true };
    throw new ImportAlreadyClaimedError(current.status);
  }
  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });

  const content = ((job.optionsJson as { content?: string } | null)?.content ?? "") as string;
  const kind = job.kind as ImportKind;
  const counts = { imported: 0, skipped: 0, failed: 0 };
  const provenanceBase = {
    importJobId: job.id,
    importedAt: new Date().toISOString(),
    importedBy: job.userId,
    originalFilename: job.filename,
    parser: `omni-import/${kind}@1`,
    byteSize: job.byteSize,
    checksum: job.checksum,
  };

  const addItem = (index: number, status: string, title: string, detail: string, sourceId?: string, extra?: object) =>
    prisma.importItem.create({
      data: {
        id: newId("imi"),
        jobId: job.id,
        index,
        status,
        title: title.slice(0, 290),
        detail: detail.slice(0, 490),
        sourceId,
        provenanceJson: { ...provenanceBase, ...(extra ?? {}) },
      },
    });

  try {
    if (kind === "url-list") {
      const urls = [...new Set(content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
      for (const [index, url] of urls.entries()) {
        const check = validateUrlSyntax(url);
        const normalized = check.ok ? normalizeUrl(url) : null;
        if (!check.ok || !normalized) {
          await addItem(index, "skipped-duplicate", url, `blocked by safety policy: ${check.ok ? "unparseable" : check.reason}`);
          counts.skipped++;
          continue;
        }
        const existing = await prisma.source.findUnique({
          where: { projectId_normalizedUrl: { projectId: job.projectId, normalizedUrl: normalized } },
        });
        if (existing) {
          await addItem(index, "skipped-duplicate", url, "already in the source library", existing.id);
          counts.skipped++;
          continue;
        }
        const source = await prisma.source.create({
          data: {
            id: newId("src"),
            projectId: job.projectId,
            url,
            normalizedUrl: normalized,
            title: url.slice(0, 290),
            status: "skipped", // metadata-only until the next research run crawls it
            failureReason: "imported URL — content is retrieved by the next research run",
            discoveredBy: "import",
          },
        });
        await addItem(index, "imported", url, "added to the source library (crawled on the next run)", source.id, { originalUrl: url });
        counts.imported++;
      }
    } else if (kind === "omni-bundle") {
      const result = await importBundle(job.projectId, job.userId, content, job.id);
      counts.imported += result.imported;
      await addItem(0, "imported", result.projectTitle, `bundle imported into NEW project ${result.newProjectId} (${result.imported} entities)`, undefined, { newProjectId: result.newProjectId });
    } else if (kind === "pdf") {
      const base64 = (job.optionsJson as { contentBase64?: string } | null)?.contentBase64;
      if (!base64) throw new Error("PDF payload missing from job");
      const binary = Buffer.from(base64, "base64");
      const pdf = await extractPdfFromBytes(binary);
      const preview = job.previewJson as ImportPreview;
      const title = (preview.stats as any)?.title ?? preview.items[0]?.title ?? "Imported PDF";
      const mainText = pdf.pageTexts.join("\n\n");
      const contentHash = sha256Hex(binary.toString("base64"));
      const duplicate = await prisma.source.findFirst({ where: { projectId: job.projectId, contentHash } });
      if (duplicate) {
        await addItem(0, "skipped-duplicate", title, `identical PDF already exists as source ${duplicate.id}`, duplicate.id);
        counts.skipped++;
      } else {
        const source = await prisma.source.create({
          data: {
            id: newId("src"), projectId: job.projectId,
            url: `omni-import://${job.id}`, normalizedUrl: `omni-import://${job.id}`,
            title: String(title).slice(0, 290), author: (preview.stats as any)?.author ?? undefined,
            status: "retrieved", crawlMethod: "pdf", contentType: "application/pdf",
            classification: "unknown", qualityScore: 50,
            scoreReasons: ["imported PDF; credibility signals unavailable for local documents"],
            retrievedAt: new Date(), wordCount: mainText.split(/\s+/).filter(Boolean).length,
            pageCount: pdf.pageTexts.length, contentHash,
            excerpt: mainText.slice(0, 1500), discoveredBy: "import",
          },
        });
        await prisma.sourceSnapshot.create({
          data: { id: newId("snap"), sourceId: source.id, kind: "main-text", contentText: mainText.slice(0, 500_000), pageTexts: pdf.pageTexts.slice(0, 300), bytes: binary.length },
        });
        await addItem(0, pdf.encrypted || pdf.imageOnly ? "failed" : "imported", title,
          pdf.encrypted ? "encrypted PDF — no text extracted" : `imported with ${pdf.pageTexts.length} page-level locations`,
          source.id, { pages: pdf.pageTexts.length, encrypted: pdf.encrypted, imageOnly: pdf.imageOnly, pdfWarnings: pdf.warnings, originalChecksum: job.checksum });
        if (pdf.encrypted || pdf.imageOnly) counts.failed++; else counts.imported++;
      }
    } else if (kind === "docx") {
      const base64 = (job.optionsJson as { contentBase64?: string } | null)?.contentBase64;
      if (!base64) throw new Error("DOCX payload missing from job");
      const binary = Buffer.from(base64, "base64");
      const doc = await parseDocx(binary);
      const preview = job.previewJson as ImportPreview;
      const title = preview.items[0]?.title ?? "Imported document";
      // Render headings as markdown so structure is preserved.
      const mainText = doc.paragraphs.map((pp) => (pp.heading ? `${"#".repeat(Math.min(6, pp.heading))} ${pp.text}` : pp.text)).join("\n\n");
      const contentHash = sha256Hex(binary.toString("base64"));
      const duplicate = await prisma.source.findFirst({ where: { projectId: job.projectId, contentHash } });
      if (duplicate) {
        await addItem(0, "skipped-duplicate", title, `identical DOCX already exists as source ${duplicate.id}`, duplicate.id);
        counts.skipped++;
      } else {
        const source = await prisma.source.create({
          data: {
            id: newId("src"), projectId: job.projectId,
            url: `omni-import://${job.id}`, normalizedUrl: `omni-import://${job.id}`,
            title: String(title).slice(0, 290), status: "retrieved", crawlMethod: "direct",
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            classification: "user-generated", qualityScore: 50,
            scoreReasons: ["imported DOCX; credibility signals unavailable for local documents"],
            retrievedAt: new Date(), wordCount: mainText.split(/\s+/).filter(Boolean).length,
            contentHash, excerpt: mainText.slice(0, 1500), discoveredBy: "import",
          },
        });
        await prisma.sourceSnapshot.create({
          data: { id: newId("snap"), sourceId: source.id, kind: "main-text", contentText: mainText.slice(0, 500_000), bytes: binary.length },
        });
        await addItem(0, "imported", title, `${doc.paragraphs.length} paragraph(s); macros ignored`, source.id,
          { paragraphs: doc.paragraphs.length, tables: doc.tables, externalLinks: doc.links, hadMacros: doc.hasMacros, originalChecksum: job.checksum });
        counts.imported++;
      }
    } else if (kind === "bibtex") {
      const parsed = parseBibtex(content);
      for (const [index, entry] of parsed.entries.entries()) {
        const pseudoUrl = entry.url ?? `omni-bib://${job.id}/${entry.citeKey}`;
        const normalized = normalizeUrl(pseudoUrl) ?? pseudoUrl;
        // DOI + normalized-title dedup against existing sources.
        const dupe = await prisma.source.findFirst({
          where: {
            projectId: job.projectId,
            OR: [
              { normalizedUrl: normalized },
              ...(entry.doi ? [{ url: { contains: entry.doi } }] : []),
              ...(entry.title ? [{ title: { equals: entry.title, mode: "insensitive" as const } }] : []),
            ],
          },
        });
        if (dupe) {
          await addItem(index, "skipped-duplicate", entry.title ?? entry.citeKey, `matches existing source ${dupe.id} (DOI/title)`, dupe.id);
          counts.skipped++;
          continue;
        }
        const source = await prisma.source.create({
          data: {
            id: newId("src"), projectId: job.projectId,
            url: pseudoUrl, normalizedUrl: normalized,
            title: (entry.title ?? entry.citeKey).slice(0, 290),
            author: entry.authors?.slice(0, 290), publisher: (entry.fields.journal ?? entry.fields.booktitle ?? entry.fields.publisher)?.slice(0, 290),
            publishedAt: entry.year && /^\d{4}$/.test(entry.year) ? new Date(`${entry.year}-01-01T00:00:00Z`) : undefined,
            status: "skipped", failureReason: "bibliographic record — content is retrieved by a research run if the URL is crawlable",
            classification: entry.entryType === "article" ? "peer-reviewed" : "unknown",
            excerpt: entry.fields.abstract?.slice(0, 1500), discoveredBy: "import",
          },
        });
        await addItem(index, "imported", entry.title ?? entry.citeKey, `bibliographic record (${entry.entryType})`, source.id,
          { citeKey: entry.citeKey, doi: entry.doi, allFields: entry.fields });
        counts.imported++;
      }
    } else if (kind === "srt" || kind === "vtt") {
      const parsed = parseSubtitles(content, kind);
      const preview = job.previewJson as ImportPreview;
      const title = preview.items[0]?.title ?? `subtitles.${kind}`;
      const contentHash = sha256Hex(content);
      const duplicate = await prisma.source.findFirst({ where: { projectId: job.projectId, contentHash } });
      if (duplicate) {
        await addItem(0, "skipped-duplicate", title, `identical subtitle file already exists as source ${duplicate.id}`, duplicate.id);
        counts.skipped++;
      } else {
        const transcript = parsed.cues.map((c) => `[${msToClock(c.startMs)}] ${c.speaker ? c.speaker + ": " : ""}${c.text}`).join("\n");
        const source = await prisma.source.create({
          data: {
            id: newId("src"), projectId: job.projectId,
            url: `omni-import://${job.id}`, normalizedUrl: `omni-import://${job.id}`,
            title: String(title).slice(0, 290), status: "retrieved", crawlMethod: "direct",
            contentType: kind === "srt" ? "application/x-subrip" : "text/vtt",
            language: parsed.language, classification: "user-generated", qualityScore: 50,
            scoreReasons: [`imported ${kind.toUpperCase()} transcript; credibility signals unavailable for local files`],
            retrievedAt: new Date(), wordCount: transcript.split(/\s+/).filter(Boolean).length,
            contentHash, excerpt: transcript.slice(0, 1500), discoveredBy: "import",
          },
        });
        // ORIGINAL file preserved exactly; timestamped rendering stored beside it.
        await prisma.sourceSnapshot.create({
          data: { id: newId("snap"), sourceId: source.id, kind: "main-text", contentText: content.slice(0, 500_000),
                  pageTexts: parsed.cues.slice(0, 2000).map((c) => `${c.start} --> ${c.end}${c.speaker ? ` [${c.speaker}]` : ""} ${c.text}`),
                  bytes: Buffer.byteLength(content) },
        });
        await addItem(0, "imported", title, `${parsed.cues.length} cue(s) with exact timestamps preserved`, source.id,
          { cueCount: parsed.cues.length, language: parsed.language, subtitleWarnings: parsed.warnings.slice(0, 10) });
        counts.imported++;
      }
    } else if (kind === "rss" || kind === "atom" || kind === "sitemap") {
      const preview = job.previewJson as ImportPreview;
      for (const item of preview.items) {
        const url = item.detail.split(" ")[0]!;
        if (item.warning) {
          await addItem(item.index, "skipped-duplicate", item.title, item.warning);
          counts.skipped++;
          continue;
        }
        const normalized = normalizeUrl(url);
        if (!normalized) { counts.skipped++; continue; }
        const existing = await prisma.source.findUnique({ where: { projectId_normalizedUrl: { projectId: job.projectId, normalizedUrl: normalized } } });
        if (existing) {
          await addItem(item.index, "skipped-duplicate", item.title, "already in the source library", existing.id);
          counts.skipped++;
          continue;
        }
        const source = await prisma.source.create({
          data: {
            id: newId("src"), projectId: job.projectId, url, normalizedUrl: normalized,
            title: item.title.slice(0, 290), status: "skipped",
            failureReason: `discovered via ${kind} import — content is retrieved by the next research run`,
            discoveredBy: "import",
          },
        });
        await addItem(item.index, "imported", item.title, "added to the source library (crawled on the next run)", source.id, { feedKind: kind });
        counts.imported++;
      }
    } else {
      // Snapshot import: one local source whose content is the imported text.
      const preview = job.previewJson as ImportPreview;
      const title = preview.items[0]?.title ?? job.filename ?? "Imported text";
      const contentHash = sha256Hex(content);
      const pseudoUrl = `omni-import://${job.id}`;
      const duplicate = await prisma.source.findFirst({ where: { projectId: job.projectId, contentHash } });
      if (duplicate) {
        await addItem(0, "skipped-duplicate", title, `identical content already exists as source ${duplicate.id}`, duplicate.id);
        counts.skipped++;
      } else {
        // EXACT PRESERVATION: the stored snapshot is the original content,
        // byte-for-byte, matching the recorded checksum. Formula escaping
        // happens only at dangerous OUTPUT boundaries (CSV export,
        // spreadsheet copy) — never in persistence, so evidence verification
        // and re-export always reference the true source.
        const safeContent = content;
        const source = await prisma.source.create({
          data: {
            id: newId("src"),
            projectId: job.projectId,
            url: pseudoUrl,
            normalizedUrl: pseudoUrl,
            title: title.slice(0, 290),
            status: "retrieved",
            crawlMethod: "direct",
            classification: "user-generated",
            qualityScore: 50,
            scoreReasons: [`imported by user (${kind}); credibility signals unavailable for local documents`],
            retrievedAt: new Date(),
            wordCount: content.trim().split(/\s+/).filter(Boolean).length,
            contentHash,
            excerpt: safeContent.slice(0, 1500),
            discoveredBy: "import",
          },
        });
        await prisma.sourceSnapshot.create({
          data: {
            id: newId("snap"),
            sourceId: source.id,
            kind: "main-text",
            contentText: safeContent.slice(0, 500_000),
            bytes: Buffer.byteLength(safeContent),
          },
        });
        await addItem(0, "imported", title, "imported as a local source snapshot", source.id, {
          stats: preview.stats,
          pastedByUser: kind === "pasted-text",
        });
        counts.imported++;
      }
    }

    const status = counts.failed > 0 || counts.skipped > 0 ? "completed-with-warnings" : "completed";
    // Persist the final summary (and drop the raw payload) so idempotent
    // retries return the same result without re-importing.
    await prisma.importJob.update({ where: { id: jobId }, data: { status, optionsJson: { summary: counts } } });
    await recordTimelineEvent(prisma, {
      projectId: job.projectId,
      type: "import-completed",
      summary: `Import (${kind}) finished: ${counts.imported} imported, ${counts.skipped} skipped`,
      entityType: "import",
      entityId: job.id,
      meta: counts,
    });
  } catch (err) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: "failed", error: String((err as Error).message).slice(0, 900) },
    });
    await recordTimelineEvent(prisma, {
      projectId: job.projectId,
      type: "import-failed",
      summary: `Import (${kind}) failed: ${String((err as Error).message).slice(0, 200)}`,
      entityType: "import",
      entityId: job.id,
    });
    throw err;
  }
  return counts;
}
