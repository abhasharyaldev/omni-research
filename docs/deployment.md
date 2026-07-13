# Deployment

## Supported: local machine (primary)

```bash
pnpm install
pnpm setup:crawlee
pnpm setup                 # readiness wizard; add --demo for a demo report
docker compose up -d       # optional: real PostgreSQL + Redis
pnpm db:migrate            # no-op if the embedded DB already migrated
pnpm db:seed -- --run      # demo user/project/report
pnpm dev                   # web :3000, api 127.0.0.1:4000, worker
```

Production-style local run: `pnpm build` then `pnpm start` (web is a compiled Next.js build; api
and worker run under tsx by design for this local-first app).

Everything binds to 127.0.0.1 except the web UI on localhost:3000. Set `AUTH_SECRET` in `.env`.

## Optional: self-hosting on your own server

Rules (enforced by design and by you):

1. The server must belong to you and be for your own use — OmniResearch must not become a shared
   subscription proxy. One person's Claude/ChatGPT/Google login must not serve other users.
2. Keep the API and worker bound to 127.0.0.1. Expose only the web app, behind a reverse proxy
   with TLS **and** authentication in front (the built-in accounts are an isolation mechanism, not
   an internet-hardened perimeter).
3. Use real PostgreSQL (docker compose or managed), not the embedded fallback.
4. Set `NODE_ENV=production`, a strong `AUTH_SECRET`, and `Secure` cookies come automatically.
5. Subscription CLIs are authenticated on that machine by you, interactively, using each vendor's
   official login. A cloud server cannot magically reuse logins from your laptop — if a provider's
   terms or tooling don't support headless/server login, that provider is simply unavailable
   there; use Ollama or mock instead.

## Environment

Copy `.env.example` → `.env`. Notable toggles:

- `USE_EMBEDDED_DB=false` to require a real PostgreSQL
- `STORE_FULL_SOURCE_CONTENT`, `SOURCE_CONTENT_RETENTION_DAYS` for retention policy
- `CRAWLER_*` crawl defaults (server-side ceilings still apply)
- `AI_PROVIDER` default provider id (`mock`, `claude-code`, `codex-cli`, `gemini-cli`, `ollama`)

## Health

`GET /api/health` reports database reachability. Docker services ship healthchecks. The worker
logs each pipeline stage transition per run.
