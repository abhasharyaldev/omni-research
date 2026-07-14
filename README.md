# OmniResearch

A **local-first research, learning, and news assistant** with verifiable citations, powered by the
official [Crawlee](https://github.com/apify/crawlee) framework.

OmniResearch crawls permitted public sources, connects every claim to stored evidence, verifies
every citation against retrieved content before a report is shown, teaches subjects and practical
skills with quizzes and spaced review, builds news catch-up briefings, and fact-checks claims —
all on your machine, **without any paid API keys**.

## What it is

- **Research assistant** — plan → preview & approve sources → crawl → evidence →
  gap-driven follow-up research → disagreement reconciliation → cited report
- **Study tutor** — units, lessons, quizzes, mastery tracking, spaced review (SM-2)
- **Skill coach** — project-based roadmaps with milestone projects
- **News briefing platform** — event clustering, timelines, syndication detection, event vs. publication dates
- **Fact-checking system** — claims vs. supporting/opposing evidence with transparent statuses
- **Source organizer / research library** — searchable, scored, deduplicated, taggable sources
- **School-project workspace** — assignment-aware research with quotation/paraphrase discipline

## Hard guarantees

- Uses the **real Crawlee** framework, verified against the official `apify/crawlee` GitHub
  repository and pinned to a release tag + commit (`vendor/crawlee-version.json`).
- **Never fabricates a citation**: evidence excerpts must exist verbatim in retrieved content, and
  every citation marker in a report is re-verified against stored source snapshots. Unverifiable
  claims are removed, not kept.
- **Respects robots.txt** and never bypasses logins, paywalls, or CAPTCHAs.
- **SSRF-hardened**: private/internal/metadata addresses are blocked at queue time, connect time
  (DNS-guarded sockets), every redirect hop, and post-response.
- **Prompt-injection isolation**: crawled text is fenced, flagged, and treated strictly as data.
- **No paid keys**: works fully offline with the deterministic mock provider; optionally uses your
  own locally installed, subscription-authenticated AI CLIs (Codex CLI, Claude Code, Gemini CLI)
  or local Ollama models. API-key environment variables are **never forwarded** — no silent
  pay-as-you-go billing.
- **Real progress only**: the live run view streams actual persisted pipeline state over SSE.

## Account-free local mode (default)

`OMNI_DEPLOYMENT_MODE=local` (the default) opens straight into the workspace: no sign-up, no
sign-in, one stable local identity created automatically (existing data is preserved — if a user
already exists, that user becomes the local identity). The API refuses to bind anywhere but
loopback in this mode. Set `OMNI_DEPLOYMENT_MODE=hosted` to restore full session authentication
for any shared or non-local deployment.

## Provider-neutral AI

OmniResearch is not tied to any single AI vendor. Adapters: Claude Code, Codex CLI, Gemini CLI,
Ollama, any **OpenAI-compatible server** (LM Studio, llama.cpp server, vLLM — set
`OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL`), and the offline mock. Each adapter declares its
capabilities (text, structured output, image input, translation suitability, local vs. remote);
tasks are gated on declared capabilities and never silently switch providers or send data to a
remote endpoint without explicit opt-in.

## Requirements

- Node.js ≥ 20, [pnpm](https://pnpm.io) ≥ 9, Git
- PostgreSQL — via `docker compose up -d` **or** the built-in embedded PostgreSQL fallback
  (no Docker needed; data lives in `.local-data/postgres`)
- Redis is optional (a database-backed local queue is used by default)

## Clone and run

```bash
git clone https://github.com/<your-username>/omni-research.git
cd omni-research
cp .env.example .env       # optional to edit now; sensible defaults work out of the box
corepack enable            # or: npm i -g pnpm@10   (ensures the pinned pnpm is available)
pnpm install
pnpm setup                 # first-run wizard: verifies toolchain + Crawlee, prepares the
                           # embedded database, detects AI providers, runs a fixture crawl
```

`.env` is git-ignored and never committed, so after cloning you always start from
`.env.example`. No values are required for local use — PostgreSQL falls back to an embedded
instance under `.local-data/`, and the offline mock provider needs no login.

Then start everything and open the app:

```bash
pnpm db:seed -- --run      # optional: demo user + project + a real cited demo report
pnpm dev                   # web http://localhost:3000 · api 127.0.0.1:4000 · worker
```

Open **http://localhost:3000**, create an account (or use the seeded demo login
`demo@omniresearch.local` / `demo-password-123`), and you're running.

### Connect your AI provider (this is what makes reports genuinely good)

The default **mock** provider is offline and only *assembles* source sentences — fine for a
demo, not real synthesis. To get real research quality, connect a tool you already have:

1. Make sure one of these is installed and logged in on your machine (no API keys needed):
   `claude` (Claude Code), `codex` (Codex CLI), `gemini` (Gemini CLI), or a local **Ollama**
   (`ollama serve` + `ollama pull llama3.1`).
2. In the app: **Settings → AI providers → Check**, then **Test connection**, then **Set default**.
3. New projects will use it. See [docs/provider-setup.md](docs/provider-setup.md) for per-tool steps
   and billing-safety notes (subscription auth only — API-key env vars are never forwarded).

### Optional extras

```bash
docker compose up -d       # real PostgreSQL + Redis instead of the embedded fallback
pnpm db:migrate            # apply migrations to that database
```

Optional web-search discovery: set `BRAVE_SEARCH_API_KEY` (or `GOOGLE_CSE_API_KEY` +
`GOOGLE_CSE_ID`) in `.env`. Keyless discovery (URLs, RSS, sitemaps, page links) works without it.

### Everyday commands

```bash
pnpm dev            # web + api + worker
pnpm test           # unit + integration tests (embedded DB auto-starts)
pnpm typecheck      # strict TS across all packages + scripts
pnpm lint           # eslint
pnpm build          # typecheck + production Next.js build
pnpm verify:crawlee # re-verify Crawlee origin, pin, exports, fixture crawl
pnpm check:providers# non-destructive AI provider detection
pnpm fixtures:serve # serve the local fixture website (e2e/demo)
pnpm test:e2e       # Playwright e2e (needs: pnpm exec playwright install chromium, pnpm dev, pnpm fixtures:serve)
```

### Provider smoke tests (LIVE — may consume subscription usage)

```bash
pnpm test:provider:claude   # or :codex :gemini :ollama
```

## AI providers

| Provider | Auth | Notes |
|---|---|---|
| Mock (default) | none | Deterministic, offline; powers demos/tests. Clearly labeled — no real synthesis quality. |
| Claude Code | your Claude account login in the official CLI | `claude -p` print mode, single turn, no tools. |
| Codex CLI | ChatGPT account (`codex login`) | `codex exec --sandbox read-only`. Not all plans include CLI access. |
| Gemini CLI | Google account login | non-interactive stdin mode. |
| Ollama | none (local models) | `ollama pull llama3.1`, local HTTP only (127.0.0.1). |

OmniResearch never asks for passwords or cookies, never reads credential files, and warns when
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` are present (they are never forwarded).

## Search & discovery

**Full-text search everywhere** (upgrade Phase 1): `Ctrl/Cmd+K` opens a global palette; the
`/search` page adds filters (type, project, dates, source quality); `Ctrl/Cmd+F` inside a report
opens an in-report finder with match counts, highlighting, and next/previous navigation — all
backed by PostgreSQL tsvector indexes (migration 0002), never only the browser's built-in find.

**Run preview**: before crawling, a run can show the plan, discovered candidate URLs (labeled with
the provider that found them), robots.txt pre-checks, duplicate/low-quality flags, and a concrete
workload estimate (pages/depth/stages — never a made-up time). Approve, prune, add URLs, or
exclude domains, then crawl exactly what you approved.

**Multi-turn reasoning**: after the first evidence pass the pipeline checks per-subquestion
coverage, asks the provider for follow-up queries when gaps exist, crawls the new candidates, and
repeats — bounded by `AI_MAX_RESEARCH_TURNS` (default 2, max 4). Concise decision notes (never
hidden chain-of-thought) are stored on the run log. Conflicting evidence between sources is
detected deterministically, reconciled by the provider (dates, primary-source status,
methodology), and reported in a **"Where sources disagree"** section — unresolved conflicts are
labeled unresolved, never papered over.

**Discovery honesty**: keyless discovery covers **your starting URLs, RSS/Atom feeds, XML
sitemaps, and links discovered on approved pages**. Optionally, supply a `BRAVE_SEARCH_API_KEY` or
`GOOGLE_CSE_API_KEY`+`GOOGLE_CSE_ID` to add real web-search discovery — keys stay server-side,
results are labeled with their provider, and every report's methodology section states exactly
what was searched. Web search is never required for core functionality.

## Story studio (storytelling skill integration)

Each project has a **Story studio** that turns verified research into video scripts. It detects a
locally installed Claude storytelling skill (`~/.claude/skills/storytelling/SKILL.md` or the
project-level equivalent) and follows its instructions verbatim on every generation — recording the
skill hash, provider, and research-package version per invocation. Without the skill it runs a
clearly-labeled built-in fallback. Every factual line stays linked to evidence refs; deterministic
validation (invented citations, altered numbers, invented quotes, sensational language, locked-fact
protection) gates the "validated" status. See [docs/storytelling.md](docs/storytelling.md).

## Monorepo layout

```
apps/web        Next.js 15 frontend (Tailwind 4, TanStack Query, SSE live progress)
apps/api        Fastify 5 API (auth, projects, runs, sources, reports, providers, SSE)
apps/worker     research worker (DB-backed queue, pipeline executor, retention cleanup)
packages/shared        types, zod schemas, crawl-limit clamping
packages/security      SSRF/IP validation, DNS-guarded safeFetch, env filtering, redaction, injection fencing
packages/crawler       Crawlee integration: manager, robots, rate limiting, extraction, dedupe, scoring, citations
packages/database      Prisma schema/client, embedded-postgres bootstrap, retention
packages/ai-providers  provider interface, safe process runner, 5 adapters
packages/research-engine  pipeline, synthesis, citation verification, exports, fact-check
packages/learning-engine  plans, lessons, quizzes, mastery, spaced review
packages/news-engine      event clustering, event-date extraction, briefings
scripts/        setup-crawlee, verify-crawlee, setup wizard, provider checks, seed
fixtures/       local fixture website/feeds served on 127.0.0.1 for tests & demos
vendor/crawlee  official Crawlee clone pinned for source auditing (created by setup:crawlee)
prisma/         schema + migrations
docs/           architecture, security, crawling policy, provider setup, deployment
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — system design, pipeline stages, data model
- [docs/security.md](docs/security.md) — SSRF defenses, prompt-injection isolation, process sandboxing, checklist
- [docs/crawling-policy.md](docs/crawling-policy.md) — robots, limits, politeness, skip reasons
- [docs/provider-setup.md](docs/provider-setup.md) — per-provider setup and billing safety
- [docs/deployment.md](docs/deployment.md) — local run and self-hosting rules

## Known limitations

See the full list in [docs/architecture.md#known-limitations](docs/architecture.md#known-limitations).
Highlights: keyless discovery is scoped to configured sources (by design); the mock provider
assembles findings rather than truly synthesizing; Playwright rendering is an optional install.
DOCX and PDF exports are genuine files (docx/pdfkit) — see docs/workspace.md.

## License

[MIT](LICENSE) — free to use, modify, and share. Crawlee is © Apify, Apache-2.0, used unmodified
via its official npm package; other dependencies retain their own licenses.
