import { sha256Hex, textSimilarity } from "@omni/shared";
import type { RetrievedPage } from "./crawler-types.js";
import { normalizeUrl } from "./url-normalizer.js";

export type DuplicateGroup = {
  /** The page chosen as the preferred representative. */
  primary: RetrievedPage;
  duplicates: { page: RetrievedPage; reason: "same-url" | "same-hash" | "near-duplicate" | "canonical" }[];
};

export function contentHashOf(text: string): string {
  return sha256Hex(text.toLowerCase().replace(/\s+/g, " ").trim());
}

/**
 * Prefer, in order: the canonical original, earliest legitimate publication
 * date, most complete text, best metadata.
 */
function preferPage(a: RetrievedPage, b: RetrievedPage): RetrievedPage {
  const aCanonical = a.canonicalUrl && normalizeUrl(a.canonicalUrl) === normalizeUrl(a.finalUrl);
  const bCanonical = b.canonicalUrl && normalizeUrl(b.canonicalUrl) === normalizeUrl(b.finalUrl);
  if (aCanonical !== bCanonical) return aCanonical ? a : b;
  const aDate = a.metadata.publishedAt?.getTime();
  const bDate = b.metadata.publishedAt?.getTime();
  if (aDate !== undefined && bDate !== undefined && aDate !== bDate) return aDate < bDate ? a : b;
  if (a.wordCount !== b.wordCount) return a.wordCount > b.wordCount ? a : b;
  const metaScore = (p: RetrievedPage) =>
    (p.metadata.author ? 1 : 0) + (p.metadata.publisher ? 1 : 0) + (p.metadata.publishedAt ? 1 : 0);
  return metaScore(a) >= metaScore(b) ? a : b;
}

const NEAR_DUPLICATE_THRESHOLD = 0.85;

/** Group retrieved pages into duplicate clusters. */
export function groupDuplicates(pages: RetrievedPage[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  for (const page of pages) {
    const pageNorm = normalizeUrl(page.finalUrl);
    const pageCanonical = page.canonicalUrl ? normalizeUrl(page.canonicalUrl) : null;
    let placed = false;

    for (const group of groups) {
      const primary = group.primary;
      const primaryNorm = normalizeUrl(primary.finalUrl);
      const primaryCanonical = primary.canonicalUrl ? normalizeUrl(primary.canonicalUrl) : null;

      let reason: DuplicateGroup["duplicates"][number]["reason"] | null = null;
      if (pageNorm && pageNorm === primaryNorm) reason = "same-url";
      else if (page.contentHash === primary.contentHash) reason = "same-hash";
      else if (pageCanonical && primaryCanonical && pageCanonical === primaryCanonical)
        reason = "canonical";
      else if (
        page.wordCount > 50 &&
        primary.wordCount > 50 &&
        sameTitle(page, primary) &&
        textSimilarity(page.mainText.slice(0, 8000), primary.mainText.slice(0, 8000)) >=
          NEAR_DUPLICATE_THRESHOLD
      ) {
        reason = "near-duplicate";
      } else if (
        page.wordCount > 200 &&
        primary.wordCount > 200 &&
        textSimilarity(page.mainText.slice(0, 8000), primary.mainText.slice(0, 8000)) >= 0.92
      ) {
        reason = "near-duplicate";
      }

      if (reason) {
        const preferred = preferPage(primary, page);
        if (preferred === page) {
          group.duplicates.push({ page: primary, reason });
          group.primary = page;
        } else {
          group.duplicates.push({ page, reason });
        }
        placed = true;
        break;
      }
    }

    if (!placed) groups.push({ primary: page, duplicates: [] });
  }

  return groups;
}

function sameTitle(a: RetrievedPage, b: RetrievedPage): boolean {
  const ta = a.metadata.title?.toLowerCase().trim();
  const tb = b.metadata.title?.toLowerCase().trim();
  return Boolean(ta && tb && ta === tb);
}
