import robotsParser, { type Robot } from "robots-parser";
import { SafeFetchError, safeFetch, type UrlPolicy } from "@omni/security";

export type RobotsDecision = {
  allowed: boolean;
  reason: string;
  crawlDelaySeconds?: number;
};

type CacheEntry = {
  robot: Robot | null; // null => no robots.txt / unreadable => allowed by default
  fetchedAt: number;
  fetchFailed: boolean;
};

const CACHE_TTL_MS = 30 * 60_000;

/**
 * Fetches and caches robots.txt per origin, and answers allow/deny for a
 * given URL + user agent. A missing or unreadable robots.txt permits crawling
 * (standard behavior); a 5xx from the robots endpoint denies crawling
 * conservatively, matching Googlebot semantics.
 */
export class RobotsPolicy {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly userAgent: string,
    private readonly policy: UrlPolicy = {},
    private readonly timeoutMs = 10_000
  ) {}

  async check(url: string): Promise<RobotsDecision> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { allowed: false, reason: "invalid URL" };
    }

    const entry = await this.getEntry(origin);
    if (entry.fetchFailed) {
      return {
        allowed: false,
        reason: "robots.txt endpoint returned a server error; crawling denied conservatively",
      };
    }
    if (!entry.robot) {
      return { allowed: true, reason: "no robots.txt present" };
    }

    const allowed = entry.robot.isAllowed(url, this.userAgent);
    if (allowed === false) {
      return { allowed: false, reason: `disallowed by robots.txt for ${this.userAgent}` };
    }
    const delay =
      entry.robot.getCrawlDelay(this.userAgent) ?? entry.robot.getCrawlDelay("*") ?? undefined;
    return {
      allowed: true,
      reason: allowed === true ? "allowed by robots.txt" : "no matching robots.txt rule",
      crawlDelaySeconds: typeof delay === "number" ? Math.min(delay, 30) : undefined,
    };
  }

  private async getEntry(origin: string): Promise<CacheEntry> {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    let entry: CacheEntry;
    try {
      const response = await safeFetch(robotsUrl, {
        timeoutMs: this.timeoutMs,
        maxBytes: 512_000,
        maxRedirects: 3,
        policy: this.policy,
        userAgent: this.userAgent,
      });
      if (response.status >= 500) {
        entry = { robot: null, fetchedAt: Date.now(), fetchFailed: true };
      } else if (response.status >= 400) {
        // 404/403 etc: treat as "no robots restrictions"
        entry = { robot: null, fetchedAt: Date.now(), fetchFailed: false };
      } else {
        const body = response.body.toString("utf8");
        entry = {
          robot: robotsParser(robotsUrl, body),
          fetchedAt: Date.now(),
          fetchFailed: false,
        };
      }
    } catch (err) {
      if (err instanceof SafeFetchError && (err.code === "unsafe-url" || err.code === "redirect-blocked")) {
        // The origin itself is unsafe; deny everything on it.
        entry = { robot: null, fetchedAt: Date.now(), fetchFailed: true };
      } else {
        // Network failure fetching robots.txt: allow (standard) but do not cache long.
        entry = { robot: null, fetchedAt: Date.now() - CACHE_TTL_MS + 60_000, fetchFailed: false };
      }
    }
    this.cache.set(origin, entry);
    return entry;
  }
}
