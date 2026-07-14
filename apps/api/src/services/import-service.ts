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
import { normalizeUrl } from "@omni/crawler";

/**
 * Universal import v1 (text formats). Flow: parse → preview (stored on the
 * job) → user confirms → commit creates Sources/snapshots with full
 * provenance. Every payload is untrusted: size caps, binary-signature
 * rejection, filename sanitization, SSRF-safe URL validation, spreadsheet
 * formula escaping, checksum idempotency, content-hash dedup.
 */

export const IMPORT_KINDS = ["pasted-text", "url-list", "markdown", "plain-text", "csv", "tsv"] as const;
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
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^https?:\/\//i.test(l.trim()))) return "url-list";
  return "pasted-text";
}

export function buildPreview(kind: ImportKind, content: string, filename?: string): ImportPreview {
  const warnings: string[] = [];
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(`Import exceeds the ${Math.round(MAX_IMPORT_BYTES / 1_048_576)} MB limit`);
  }
  const binaryReason = rejectNonText(bytes);
  if (binaryReason) throw new Error(binaryReason);

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
  kind?: ImportKind;
  filename?: string;
}): Promise<{ jobId: string; preview: ImportPreview; duplicateOfJobId?: string }> {
  const prisma = getPrisma();
  const kind = args.kind ?? detectKind(args.filename, args.content);
  const checksum = createHash("sha256").update(args.content).digest("hex");

  // Idempotency: an identical payload already imported for this project.
  const existing = await prisma.importJob.findUnique({
    where: { projectId_checksum_kind: { projectId: args.projectId, checksum, kind } },
  });
  if (existing) {
    return { jobId: existing.id, preview: existing.previewJson as ImportPreview, duplicateOfJobId: existing.id };
  }

  const preview = buildPreview(kind, args.content, args.filename);
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
      optionsJson: { content: args.content }, // bounded by MAX_IMPORT_BYTES
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
