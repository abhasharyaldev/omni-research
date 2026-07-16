import type {
  CrawlLimits,
  DiscoveredBy,
  ResearchRequestData,
  SkipReason,
  SourceClassification,
} from "@omni/shared";
import type { UrlPolicy } from "@omni/security";

export type CrawlTask = {
  url: string;
  userData: ResearchRequestData;
};

export type PageLink = {
  url: string;
  text: string;
  rel?: string;
};

export type ExtractedMetadata = {
  title?: string;
  author?: string;
  publisher?: string;
  description?: string;
  language?: string;
  publishedAt?: Date;
  modifiedAt?: Date;
  canonicalUrl?: string;
  siteName?: string;
  isOpinionSection?: boolean;
};

export type RetrievedPage = {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  userData: ResearchRequestData;
  status: number;
  contentType: string;
  crawlMethod: "cheerio" | "playwright" | "feed" | "pdf" | "direct" | "video";
  retrievedAt: Date;
  metadata: ExtractedMetadata;
  mainText: string;
  headings: string[];
  wordCount: number;
  contentHash: string;
  outboundLinks: PageLink[];
  pageCount?: number; // PDFs
  pageTexts?: string[]; // PDFs, by page
  rawHtmlBytes?: number;
  paywallSuspected: boolean;
  loginSuspected: boolean;
};

export type SkippedPage = {
  url: string;
  userData?: ResearchRequestData;
  reason: SkipReason;
  detail: string;
};

export type FailedPage = {
  url: string;
  userData?: ResearchRequestData;
  error: string;
  retries: number;
};

export type CrawlOutcome = {
  retrieved: RetrievedPage[];
  skipped: SkippedPage[];
  failed: FailedPage[];
  totalBytesDownloaded: number;
  cancelled: boolean;
};

export type CrawlEvent =
  | { kind: "queued"; url: string }
  | { kind: "crawling"; url: string; domain: string }
  | { kind: "retrieved"; url: string; finalUrl: string; wordCount: number }
  | { kind: "skipped"; url: string; reason: SkipReason; detail: string }
  | { kind: "failed"; url: string; error: string }
  | { kind: "robots-check"; url: string; allowed: boolean }
  | { kind: "safety-check"; url: string; allowed: boolean };

export type CrawlOptions = {
  tasks: CrawlTask[];
  limits: CrawlLimits;
  policy: UrlPolicy;
  userAgent: string;
  storageDir: string;
  runId: string;
  onEvent?: (event: CrawlEvent) => void;
  shouldCancel?: () => boolean;
  /** Escalate to Playwright when a page looks JS-rendered. Default false. */
  allowPlaywrightFallback?: boolean;
};

export type SearchInput = {
  query: string;
  maxResults?: number;
  dateRangeStart?: Date;
  dateRangeEnd?: Date;
  region?: string;
};

export type SearchResult = {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: Date;
  discoveredBy: DiscoveredBy;
  /** Which concrete provider produced this result (e.g. "brave", "rss"). */
  providerId?: string;
};

export interface SearchProvider {
  id: string;
  /** Honest description of what this provider can actually search. */
  coverage: string;
  search(input: SearchInput): Promise<SearchResult[]>;
}

export type ClassifiedSource = {
  classification: SourceClassification;
  qualityScore: number; // 0..100
  reasons: string[];
};
