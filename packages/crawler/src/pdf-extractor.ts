import { extractText, getDocumentProxy } from "unpdf";
import { parseMetaDate, sha256Hex } from "@omni/shared";
import { safeFetch, type UrlPolicy } from "@omni/security";
import type { ResearchRequestData } from "@omni/shared";
import type { RetrievedPage } from "./crawler-types.js";

export type PdfFetchOptions = {
  policy?: UrlPolicy;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * Fetch a public PDF through the SSRF-safe fetcher and extract per-page text
 * plus document metadata. Throws on failure — the caller preserves the source
 * record and shows the failure clearly.
 */
export async function fetchPdf(
  url: string,
  userData: ResearchRequestData,
  options: PdfFetchOptions = {}
): Promise<RetrievedPage> {
  const response = await safeFetch(url, {
    policy: options.policy,
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? 45_000,
    maxBytes: options.maxBytes ?? 20_000_000,
    allowedContentTypes: ["application/pdf", "application/octet-stream", "binary/octet-stream"],
  });
  if (response.status >= 400) {
    throw new Error(`PDF ${url} returned HTTP ${response.status}`);
  }
  // Verify magic bytes regardless of declared content type.
  if (!response.body.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new Error(`Response from ${url} is not a PDF (missing %PDF header)`);
  }

  const data = new Uint8Array(response.body);
  const pdf = await getDocumentProxy(data);
  const { totalPages, text: pageTexts } = await extractText(pdf, { mergePages: false });

  let title: string | undefined;
  let author: string | undefined;
  let publishedAt: Date | undefined;
  try {
    const meta = await (pdf as any).getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
    author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined;
    const created = typeof info.CreationDate === "string" ? pdfDate(info.CreationDate) : undefined;
    publishedAt = created ?? parseMetaDate(String(info.ModDate ?? ""));
  } catch {
    // metadata is optional; text extraction result stands on its own
  }

  const texts = (Array.isArray(pageTexts) ? pageTexts : [String(pageTexts)]).map((t) =>
    t.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim()
  );
  const mainText = texts.join("\n\n");
  const headings: string[] = [];

  return {
    requestedUrl: url,
    finalUrl: response.finalUrl,
    canonicalUrl: undefined,
    userData,
    status: response.status,
    contentType: "application/pdf",
    crawlMethod: "pdf",
    retrievedAt: new Date(),
    metadata: { title, author, publishedAt },
    mainText,
    headings,
    wordCount: mainText.split(/\s+/).filter(Boolean).length,
    contentHash: sha256Hex(mainText.toLowerCase().replace(/\s+/g, " ").trim()),
    outboundLinks: [],
    pageCount: totalPages,
    pageTexts: texts,
    paywallSuspected: false,
    loginSuspected: false,
  };
}

/** Parse PDF date strings like D:20240115120000+00'00' */
function pdfDate(value: string): Date | undefined {
  const m = value.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Date.UTC(
      Number(y),
      Number(mo ?? "01") - 1,
      Number(d ?? "01"),
      Number(h ?? "0"),
      Number(mi ?? "0"),
      Number(s ?? "0")
    )
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Parse PDF BYTES (universal import path — no network). Verifies the %PDF
 * signature, extracts page-level text, detects encrypted and image-only
 * documents, and reports honest extraction warnings. */
export async function extractPdfFromBytes(bytes: Buffer): Promise<{
  pageTexts: string[];
  title?: string;
  author?: string;
  publishedAt?: Date;
  encrypted: boolean;
  imageOnly: boolean;
  warnings: string[];
}> {
  if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new Error("Not a PDF: missing %PDF signature (extensions and MIME types are not trusted)");
  }
  const warnings: string[] = [];
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const message = (err as Error).message ?? "";
    if (/password|encrypt/i.test(message)) {
      return { pageTexts: [], encrypted: true, imageOnly: false, warnings: ["PDF is encrypted; text cannot be extracted without the password"] };
    }
    throw new Error(`PDF parser failed: ${message.slice(0, 200)}`);
  }
  const { text: raw } = await extractText(pdf, { mergePages: false });
  const pageTexts = (Array.isArray(raw) ? raw : [String(raw)]).map((t) =>
    t.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim()
  );
  let title: string | undefined;
  let author: string | undefined;
  let publishedAt: Date | undefined;
  try {
    const meta = await (pdf as any).getMetadata();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
    author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined;
    publishedAt = typeof info.CreationDate === "string" ? pdfDate(info.CreationDate) : undefined;
  } catch {
    warnings.push("PDF metadata could not be read");
  }
  const totalChars = pageTexts.join("").length;
  const imageOnly = totalChars < 40 * Math.max(1, pageTexts.length);
  if (imageOnly) warnings.push("Little or no extractable text — this may be a scanned/image-only PDF; OCR is not performed (and is never claimed)");
  const emptyPages = pageTexts.filter((t) => t.length === 0).length;
  if (!imageOnly && emptyPages > 0) warnings.push(`${emptyPages} page(s) contained no extractable text`);
  return { pageTexts, title, author, publishedAt, encrypted: false, imageOnly, warnings };
}
