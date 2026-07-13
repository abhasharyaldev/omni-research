import { sleep } from "@omni/shared";

type DomainState = {
  nextAllowedAt: number;
  inFlight: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  delayMs: number;
};

/**
 * Per-domain politeness: minimum delay between requests, per-domain
 * concurrency cap, exponential backoff on failures, Retry-After support, and
 * a cooldown after repeated failures.
 */
export class DomainRateLimiter {
  private domains = new Map<string, DomainState>();

  constructor(
    private readonly options: {
      defaultDelayMs: number;
      maxPerDomainConcurrency: number;
      failureThreshold?: number;
      cooldownMs?: number;
    }
  ) {}

  private state(domain: string): DomainState {
    let s = this.domains.get(domain);
    if (!s) {
      s = {
        nextAllowedAt: 0,
        inFlight: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
        delayMs: this.options.defaultDelayMs,
      };
      this.domains.set(domain, s);
    }
    return s;
  }

  /** True when the domain is in cooldown after repeated failures. */
  isCoolingDown(domain: string): boolean {
    return this.state(domain).cooldownUntil > Date.now();
  }

  /** Wait until the domain permits another request, then reserve a slot. */
  async acquire(domain: string): Promise<void> {
    const s = this.state(domain);
    // Wait for concurrency slot
    while (s.inFlight >= this.options.maxPerDomainConcurrency) {
      await sleep(50);
    }
    // Wait for the politeness delay window
    for (;;) {
      const now = Date.now();
      const waitUntil = Math.max(s.nextAllowedAt, s.cooldownUntil);
      if (now >= waitUntil) break;
      await sleep(Math.min(waitUntil - now, 500));
    }
    s.inFlight++;
    s.nextAllowedAt = Date.now() + s.delayMs;
  }

  release(domain: string): void {
    const s = this.state(domain);
    s.inFlight = Math.max(0, s.inFlight - 1);
  }

  reportSuccess(domain: string): void {
    const s = this.state(domain);
    s.consecutiveFailures = 0;
    s.delayMs = this.options.defaultDelayMs;
  }

  reportFailure(domain: string): void {
    const s = this.state(domain);
    s.consecutiveFailures++;
    s.delayMs = Math.min(s.delayMs * 2, 60_000); // exponential backoff, capped
    const threshold = this.options.failureThreshold ?? 5;
    if (s.consecutiveFailures >= threshold) {
      s.cooldownUntil = Date.now() + (this.options.cooldownMs ?? 5 * 60_000);
    }
  }

  /** Apply Retry-After (seconds or HTTP date) or a robots crawl-delay. */
  applyRetryAfter(domain: string, retryAfter: string | number | undefined): void {
    const s = this.state(domain);
    if (retryAfter === undefined) {
      s.delayMs = Math.min(s.delayMs * 2, 60_000);
      return;
    }
    let waitMs: number | undefined;
    if (typeof retryAfter === "number") {
      waitMs = retryAfter * 1000;
    } else if (/^\d+$/.test(retryAfter.trim())) {
      waitMs = Number(retryAfter.trim()) * 1000;
    } else {
      const date = new Date(retryAfter);
      if (!Number.isNaN(date.getTime())) waitMs = date.getTime() - Date.now();
    }
    if (waitMs !== undefined && waitMs > 0) {
      s.nextAllowedAt = Date.now() + Math.min(waitMs, 5 * 60_000);
    }
  }

  applyCrawlDelay(domain: string, seconds: number): void {
    const s = this.state(domain);
    s.delayMs = Math.max(s.delayMs, Math.min(seconds * 1000, 30_000));
  }
}
