import { textSimilarity } from "@omni/shared";

export type NewsArticle = {
  sourceId: string;
  title: string;
  snippet?: string;
  publishedAt?: Date;
  publisher?: string;
  contentHash?: string;
  url: string;
};

export type NewsCluster = {
  index: number;
  headline: string;
  articles: NewsArticle[];
  earliestPublishedAt?: Date;
  syndicatedSourceIds: string[];
};

const CLUSTER_SIMILARITY = 0.32; // title/snippet 2-shingle overlap
const SAME_EVENT_WINDOW_MS = 4 * 86_400_000;

/**
 * Deterministic clustering of articles into events: articles whose
 * title+snippet overlap strongly and whose publication dates are close are
 * treated as coverage of the same development. Identical content hashes are
 * syndicated copies, not separate developments.
 */
export function clusterArticles(articles: NewsArticle[]): NewsCluster[] {
  const clusters: NewsCluster[] = [];
  const sorted = [...articles].sort(
    (a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0)
  );

  for (const article of sorted) {
    const text = `${article.title} ${article.snippet ?? ""}`;
    let bestCluster: NewsCluster | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const representative = cluster.articles[0]!;
      // Syndication: identical body content
      if (article.contentHash && article.contentHash === representative.contentHash) {
        bestCluster = cluster;
        bestScore = 1;
        break;
      }
      const timeOk =
        !article.publishedAt ||
        !cluster.earliestPublishedAt ||
        Math.abs(article.publishedAt.getTime() - cluster.earliestPublishedAt.getTime()) <= SAME_EVENT_WINDOW_MS;
      if (!timeOk) continue;
      // Body/snippet 2-shingle overlap catches near-identical coverage;
      // title token overlap catches reworded headlines for the same event.
      const shingleScore = textSimilarity(text, `${representative.title} ${representative.snippet ?? ""}`, 2);
      const titleScore = textSimilarity(article.title, representative.title, 1);
      const score = Math.max(shingleScore, titleScore >= 0.5 ? CLUSTER_SIMILARITY : 0);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= CLUSTER_SIMILARITY) {
      bestCluster.articles.push(article);
      if (
        article.contentHash &&
        bestCluster.articles.some((a) => a !== article && a.contentHash === article.contentHash)
      ) {
        bestCluster.syndicatedSourceIds.push(article.sourceId);
      }
      if (
        article.publishedAt &&
        (!bestCluster.earliestPublishedAt || article.publishedAt < bestCluster.earliestPublishedAt)
      ) {
        bestCluster.earliestPublishedAt = article.publishedAt;
      }
    } else {
      clusters.push({
        index: clusters.length,
        headline: article.title,
        articles: [article],
        earliestPublishedAt: article.publishedAt,
        syndicatedSourceIds: [],
      });
    }
  }
  return clusters;
}

/**
 * Extract an explicit event date mentioned in text ("on July 8, 2026",
 * ISO dates). Returns undefined instead of guessing — the publication date is
 * NOT assumed to be the event date.
 */
export function extractEventDate(text: string, referenceYear?: number): Date | undefined {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const longForm = text.match(
    /\bon\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i
  );
  if (longForm) {
    const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
    const month = months.indexOf(longForm[1]!.toLowerCase());
    const year = longForm[3] ? Number(longForm[3]) : referenceYear;
    if (month >= 0 && year) {
      const date = new Date(Date.UTC(year, month, Number(longForm[2])));
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return undefined;
}
