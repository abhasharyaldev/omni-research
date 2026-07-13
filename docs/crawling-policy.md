# Crawling policy

OmniResearch is a **polite, permission-respecting** crawler.

## What is never crawled

- Pages disallowed by `robots.txt` (checked per request; 5xx on the robots endpoint denies
  crawling conservatively; crawl-delay directives are honored up to 30s)
- Login-protected or private account pages (401/403 and login-wall content are recorded as
  `login-required` and never bypassed)
- Paywalled content (paywall heuristics flag and truncate-suspect pages; nothing is circumvented)
- CAPTCHAs or any technical access control — no bypassing, ever
- Private/internal network destinations (see docs/security.md)
- Executables, installers, scripts, archives, disk images, unknown binaries

## Supported content

Public HTML/plain text, public PDFs (per-page text + page-number citation locators; failed
extraction preserves the source record with a visible failure), RSS/Atom feeds, XML sitemaps, and
JSON only from explicitly permitted public endpoints. Downloaded files are never executed.

## Limits (server-side, clamped to hard ceilings)

| Limit | Default | Ceiling |
|---|---|---|
| Concurrency | 5 | 10 |
| Pages per run | 50 | 200 |
| Pages per domain | 10 | 40 |
| Depth | 2 | 4 |
| Request timeout | 30s | 60s |
| Response size | 10 MB | 25 MB |
| Total download | 100 MB | 250 MB |
| Delay per domain | 1s | — (raised by crawl-delay/Retry-After) |
| Retries | 2 | 5 |
| Redirects | 5 | 8 |
| Run duration | 15 min | 30 min |

Users may lower limits; values above the ceilings are clamped (`clampCrawlLimits`). Unlimited
crawling is impossible.

## Politeness

Per-domain: minimum delay between requests, max 2 concurrent requests, exponential backoff on
failures, `Retry-After` support on 429s, cooldown after repeated failures, and a self-identifying
user agent (`CRAWLER_USER_AGENT`). `nofollow` links are not followed.

## Skip transparency

Every skipped page is recorded with one of: robots-disallowed, login-required, paywall-detected,
unsupported-content-type, unsafe-url, private-network, domain-blocked, duplicate-url,
duplicate-content, crawl-limit-reached, redirect-blocked, response-too-large, request-failed,
rate-limited, cancelled — all visible in the live run's page table and the research log.
