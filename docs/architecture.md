# Architecture

## Overview

OmniResearch is a local-first TypeScript monorepo (pnpm workspaces):

```
Browser
   ↓  (same-origin; Next.js rewrites /api/* to the local API)
apps/web  — Next.js 15 App Router UI
   ↓
apps/api  — Fastify 5 (127.0.0.1 only), sessions, validation, SSE
   ↓  PostgreSQL (docker compose or embedded fallback)
apps/worker — DB-backed job loop
   ├── @omni/crawler         (Crawlee: CheerioCrawler + optional Playwright)
   ├── @omni/ai-providers    (Codex CLI / Claude Code / Gemini CLI / Ollama / mock)
   ├── @omni/research-engine (pipeline + citation verification + exports)
   ├── @omni/learning-engine (plans, quizzes, spaced review)
   └── @omni/news-engine     (clustering, briefings)
```

All server processes bind to `127.0.0.1`. The web app is the only browser-facing surface and
proxies API calls, so cookies stay same-origin.

## Crawlee installation strategy

`scripts/setup-crawlee.ts`:

1. Confirms Git is installed.
2. Reads the installed `crawlee` npm version (the actual runtime dependency, pinned by
   `pnpm-lock.yaml`).
3. Resolves the matching `vX.Y.Z` tag **directly from GitHub** via
   `git ls-remote --tags https://github.com/apify/crawlee.git` — the tag/commit are never invented.
4. Shallow-clones the official repository at that tag into `vendor/crawlee`.
5. Verifies the clone origin is exactly `https://github.com/apify/crawlee` and that `HEAD` equals
   the remote tag commit.
6. Verifies required exports (`CheerioCrawler`, `PlaywrightCrawler`, `RequestQueue`,
   `Configuration`) import from the installed package.
7. Records everything in `vendor/crawlee-version.json`.
8. Runs a real fixture crawl (robots enforcement included) and reports success/failure.

Rationale (the "safest compatible strategy" from the requirements): the official npm package **is**
the officially supported installation method and is published from this repository; the GitHub
clone provides origin verification and source auditing. Crawlee is never modified — all behavior
is added through adapters in `packages/crawler`. `pnpm verify:crawlee` re-checks all of the above.

## Research pipeline (packages/research-engine/src/pipeline.ts)

Explicit stages, each persisted to `ResearchRun.stage` + `RunEvent` rows (the SSE stream reads
these — progress is real state, never simulated):

1. **understanding-request / building-plan** — provider generates (or reuses the user-edited)
   plan: main question, subquestions, key terms, discovery queries, outline.
2. **generating-subquestions** — persisted, linked to topics.
3. **discovering-sources** — user URLs, RSS feeds, sitemaps (both fetched through the SSRF-safe
   fetcher), plus a mock search provider for demos. Every discovery query is recorded.
4. **scoring-candidates** — keyword-overlap ranking + per-domain balancing *before* crawling;
   only the strongest candidates consume crawl budget.
5. **crawling / extracting-content** — wave-by-wave via `crawlPages()` (Crawlee CheerioCrawler).
   Each wave's outbound links are scored to form the next wave until `maxDepth` /
   `maxSources` is reached. Every page outcome (retrieved/skipped/failed + reason) is stored on
   `CrawlRequest`.
6. **deduplicating** — normalized URLs, canonical URLs, content hashes, near-duplicate shingle
   similarity; duplicates are grouped under the preferred (canonical/earliest/most complete) source.
7. **classifying-sources** — transparent heuristic quality score; every adjustment is stored in
   `scoreReasons` and shown in the UI. Injection-suspicious sources are flagged on the run log.
8. **extracting-evidence** — sources are sentence-split; the provider returns evidence records
   whose `evidenceText` **must be verbatim**. Records that don't appear verbatim in the retrieved
   content are discarded and logged — fabricated citations cannot enter the database.
9. **writing-report** — synthesis with numbered evidence markers; provider is told to mark
   inference and to say when evidence is missing.
10. **verifying-citations (mandatory)** — every `[n]` marker must map to stored evidence whose
    excerpt exists verbatim in the stored source snapshot. Invalid markers are removed; lines with
    no verified support are removed; all removals are reported in the run log and the report's
    limitations.

Failures at any stage preserve completed work (sources, evidence) and mark the run `failed` with a
clear message; provider failures name the provider and error class and invite switching providers
without re-crawling.

## Queue

The worker claims runs atomically (`updateMany where status='queued'`) from PostgreSQL — a real,
restart-safe local queue with no Redis requirement. `docker-compose.yml` ships Redis for users who
want it later; the abstraction point is `apps/worker/src/index.ts`.

## Database

Single Prisma schema (`prisma/schema.prisma`) with ~35 models covering users/sessions, projects,
topics, runs (+ events, subquestions, discovery queries, crawl requests), sources (+ snapshots,
tags, collections), evidence/claims/citations/reports, the full learning system, news events,
exports, audit log, and provider status. Key invariants:

- `Source` unique on `(projectId, normalizedUrl)`; `CrawlRequest` unique on `(runId, normalizedUrl)`
- `Citation` unique on `(reportId, marker)` and always references a `Source` (+ usually `Evidence`)
- every user-facing query filters by `ownerId` server-side (`requireProject`/`requireRun`/`requireSource`)

### Embedded PostgreSQL fallback

`packages/database/src/bootstrap.ts`: if `DATABASE_URL` is unreachable and `USE_EMBEDDED_DB` is not
`false`, an embedded PostgreSQL (the `embedded-postgres` package, zonky binaries) is started under
`.local-data/postgres` on port 5498 and migrations are applied with `prisma migrate deploy`. This is
what makes `pnpm test` and `pnpm dev` work with zero external services.

## Live progress

`GET /api/research-runs/:id/events` is an SSE stream that polls the run row + `RunEvent` log every
second and emits `state` and `log` events. The frontend renders stages, counters (pages
discovered/queued/completed/skipped/failed, sources, evidence, citations), elapsed time, provider,
the per-page crawl table with skip reasons, and Stop/Pause/Resume controls. There are no simulated
percentages anywhere.

## Learning flow

`learn-subject` / `learn-skill` projects build a `LearningPlan`: the provider produces the
unit/lesson skeleton immediately (prerequisites ordered, milestone projects per unit); each
lesson's full body (simple + detailed explanation, rules, worked examples, common mistakes,
guided/independent practice, quiz with explanations, real-world application, mastery criteria) is
generated on first open. Quizzes are graded deterministically; scores update per-concept mastery
(EMA) and SM-2 spaced-review schedules.

## News flow

`news-catchup` runs execute the normal pipeline, then cluster retrieved articles into events
(title-token + shingle similarity within a 4-day window; identical content hashes = syndicated
copies), extract explicit **event dates** from text (never guessing — publication date is used
only as a labeled fallback), and summarize each cluster via the provider with confidence levels
derived from independent-source counts.

## Fact-check flow

Claims are matched against the project's stored evidence (similarity + negation-stance heuristic);
the provider assigns one of the eight transparent statuses with an explanation; results persist as
`Claim`/`ClaimEvidence` rows with supporting and opposing excerpts shown.

## Exports

Markdown, HTML (print-to-PDF), JSON archive, CSV source list, CSV flashcards, and APA/MLA/Chicago/
web bibliographies — all preserving research question, generation date, retrieval dates,
citations, limitations, and provider used. Missing metadata is labeled ("Author unavailable"),
never guessed.

## Known limitations

- **Discovery scope**: no web-search API by design; research covers configured URLs/feeds/sitemaps
  and links found on approved pages, and reports say so explicitly.
- **Mock provider**: assembles findings from real source sentences; it is honest but not a real
  synthesist. Connect Claude Code/Codex/Gemini/Ollama for real synthesis.
- **Playwright**: optional; JS-rendered pages fall back to their thin HTML with a clear log entry
  unless `playwright` + Chromium are installed.
- **Pause** is cooperative (takes effect at stage boundaries); resume re-queues the run and reuses
  already-saved plan/sources (upserts make re-crawls idempotent).
- **DOCX export** is not implemented; HTML/Markdown exports open cleanly in Word.
- **CLI provider auth detection** is heuristic (config-file presence) until the user runs the
  explicit "Test connection" action, because a real check could consume plan usage.
- SSE uses 1s DB polling (simple, correct); a LISTEN/NOTIFY upgrade is a straightforward follow-up.
- Embedded-postgres is for local development; production self-hosting should run real PostgreSQL.

## Phase-1 upgrade (search, preview, multi-turn reasoning)

### Full-text search
Migration `0002_full_text_search` adds generated `tsvector` columns + GIN indexes to Source,
Evidence, ReportSection, Claim, Citation, Project, and Note. `GET /api/search` runs parameterized
`websearch_to_tsquery` queries per entity type, scoped to the owner, ranked with `ts_rank`, with
`ts_headline` snippets using `[[ ]]` delimiters (plain text; the client converts them to `<mark>`
— no HTML round-trips). Filters: type list, project, date range, minimum source quality. The web
app adds a `Ctrl/Cmd+K` palette, a `/search` page with filters, and an in-report finder
(`Ctrl/Cmd+F`, match count, next/previous, highlight) that coexists with citation markers.

### Web-search providers
`packages/crawler/src/web-search-providers.ts` defines optional keyed providers (Brave Search,
Google Programmable Search) behind the existing `SearchProvider` interface, with per-provider rate
limiting, retries with backoff, and timeouts. Keys come from server-side env only. Result URLs are
labeled (`providerId`) and still pass the full SSRF/robots/limits pipeline before any fetch.
Keyless discovery is unchanged and always sufficient for core use.

### Run preview
`buildRunPreview` (packages/research-engine/src/preview.ts) reuses the shared
`discoverCandidates()` module to produce the plan, labeled candidates, robots.txt pre-checks
(bounded to the top 30), duplicate/user-generated/opinion flags, per-domain counts, and a workload
estimate in concrete units. `POST /api/projects/:id/research-runs/preview` exposes it;
approval passes `approvedUrls`/`excludedUrls`/`planJson`/limits back to the run-start endpoint,
and the pipeline crawls exactly the approved list (still re-validating everything server-side).

### Multi-turn reasoning loop
The pipeline now factors crawling/persisting/extraction into reusable wave functions and adds a
bounded loop after the first evidence pass: deterministic gap check (evidence per subquestion) →
provider `gap-analysis` task (follow-up queries + one-sentence decision note; stored on the run
log — no hidden chain-of-thought) → follow-up discovery → crawl → extract. Bounds: `maxResearchTurns`
(0–4, default `AI_MAX_RESEARCH_TURNS`=2), the run's source cap, crawl limits, and repeated-query
suppression. New stages: `identifying-gaps`, `following-up`, `reconciling-disagreements`.

### Disagreement reconciliation
`detectConflicts` finds evidence pairs from different sources with topical overlap and opposing
polarity (negation mismatch or antonym pairs). The provider's `reconciliation` task classifies each
conflict (factual/interpretation/methodology/timing), checks dates and source class, and must mark
unresolvable conflicts `unresolved`. Results persist as disputed `Claim` rows with stance-labeled
`ClaimEvidence` links and render as a "Where sources disagree" report section whose citations go
through the same mandatory verification as everything else.
