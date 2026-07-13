import type { CitationStyle } from "@omni/shared";

/**
 * Citation formatting. Missing metadata is labeled explicitly
 * ("Author unavailable", "Publication date unavailable") — never guessed.
 */

export type CitationSourceInfo = {
  title?: string;
  author?: string;
  publisher?: string;
  publishedAt?: Date;
  retrievedAt: Date;
  url: string;
  pageNumber?: number;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function fmtDateLong(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function fmtDateMla(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]!.slice(0, 3)}. ${date.getUTCFullYear()}`;
}

/** Format "Last, F." best-effort from a display name; returns name as-is when unsure. */
function apaAuthor(author: string): string {
  const cleaned = author.replace(/^by\s+/i, "").trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2 || parts.length > 4 || cleaned.includes(",")) return cleaned;
  const last = parts[parts.length - 1]!;
  const initials = parts
    .slice(0, -1)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join(" ");
  return `${last}, ${initials}`;
}

export function formatCitation(source: CitationSourceInfo, style: CitationStyle): string {
  const title = source.title?.trim() || "Untitled document";
  const author = source.author?.trim();
  const publisher = source.publisher?.trim();
  const pub = source.publishedAt;
  const retrieved = source.retrievedAt;
  const page = source.pageNumber !== undefined ? source.pageNumber : undefined;

  switch (style) {
    case "apa": {
      const authorPart = author ? apaAuthor(author) : "[Author unavailable]";
      const datePart = pub ? `(${pub.getUTCFullYear()}, ${MONTHS[pub.getUTCMonth()]} ${pub.getUTCDate()})` : "(n.d.)";
      const publisherPart = publisher ? ` ${publisher}.` : "";
      const pagePart = page !== undefined ? ` (p. ${page}).` : "";
      return `${authorPart} ${datePart}. ${title}.${pagePart}${publisherPart} Retrieved ${fmtDateLong(retrieved)}, from ${source.url}`;
    }
    case "mla": {
      const authorPart = author ? `${author}. ` : "";
      const publisherPart = publisher ? `${publisher}, ` : "";
      const datePart = pub ? `${fmtDateMla(pub)}, ` : "[publication date unavailable], ";
      const pagePart = page !== undefined ? `p. ${page}. ` : "";
      return `${authorPart}"${title}." ${publisherPart}${datePart}${pagePart}${source.url}. Accessed ${fmtDateMla(retrieved)}.`;
    }
    case "chicago": {
      const authorPart = author ? `${author}. ` : "";
      const publisherPart = publisher ? `${publisher}. ` : "";
      const datePart = pub ? `${fmtDateLong(pub)}. ` : "Publication date unavailable. ";
      const pagePart = page !== undefined ? `Page ${page}. ` : "";
      return `${authorPart}"${title}." ${publisherPart}${datePart}${pagePart}Accessed ${fmtDateLong(retrieved)}. ${source.url}.`;
    }
    case "web":
    default: {
      const bits = [
        title,
        author ? `by ${author}` : "Author unavailable",
        publisher,
        pub ? fmtDateLong(pub) : "Publication date unavailable",
        page !== undefined ? `page ${page}` : undefined,
        source.url,
        `retrieved ${fmtDateLong(retrieved)}`,
      ].filter(Boolean);
      return bits.join(" — ");
    }
  }
}
