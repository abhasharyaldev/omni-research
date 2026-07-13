# AI provider setup

OmniResearch talks to **locally installed, officially authenticated** AI tools. It never asks for
passwords, never touches browser cookies or credential files, never proxies your subscription to
other people, and never forwards API-key environment variables (no silent pay-as-you-go billing).

The default provider is the **mock provider**: zero setup, offline, deterministic — used for the
demo and all automated tests. Its reports are honest but assembled, not truly synthesized.

## Claude Code

1. Install Claude Code (https://claude.com/claude-code) so `claude` is on PATH
   (or set `CLAUDE_CLI_PATH`).
2. Run `claude` once and log in with your Claude account (subscription auth).
3. Settings → AI providers → Claude Code → **Check**, then **Test connection**
   (one tiny request; may count against plan usage).

OmniResearch invokes `claude -p --output-format json --max-turns 1` with the prompt on stdin — a
single non-agentic turn with no tool grants. If `ANTHROPIC_API_KEY` is set in your environment you
get a warning; it is never forwarded, so Claude Code keeps using your subscription login.

## OpenAI Codex CLI

1. Install the official Codex CLI so `codex` is on PATH (or set `CODEX_CLI_PATH`).
2. Run `codex login` and sign in with your ChatGPT account. Not every plan includes Codex CLI —
   an unsupported plan surfaces as a clear `unsupported-plan` error, never a workaround.
3. Check + Test connection from Settings.

Invocation: `codex exec --sandbox read-only --skip-git-repo-check -` in an isolated temp directory.
`OPENAI_API_KEY` is never forwarded.

## Gemini CLI

1. Install the official Gemini CLI so `gemini` is on PATH (or set `GEMINI_CLI_PATH`).
2. Run `gemini` once and complete the Google-account login.
3. Check + Test connection from Settings.

Prompts go via stdin in non-interactive mode; no auto-approval flags are ever passed.
`GEMINI_API_KEY`/`GOOGLE_API_KEY` are never forwarded.

## Ollama (fully local)

1. Install from https://ollama.com and start it (`ollama serve` runs automatically on install).
2. `ollama pull llama3.1` (or set `OLLAMA_MODEL` to any pulled model).
3. Check from Settings — status shows missing-server and missing-model conditions explicitly.

`OLLAMA_BASE_URL` must point at 127.0.0.1 — remote Ollama endpoints are rejected so the app can't
be misused as a bridge to someone else's machine.

## Quotas, limits, failures

Capability and plan support are **detected, not assumed**. Usage-limit and auth errors from a CLI
map to typed statuses (`usage-limit-reached`, `authentication-required`, `unsupported-plan`) shown
in Settings and run errors. When a provider fails mid-run, all crawled sources and extracted
evidence are already saved — switch providers in project settings and regenerate the report
without re-crawling. Providers are never switched silently.

## Manual smoke tests (live)

```bash
pnpm test:provider:claude
pnpm test:provider:codex
pnpm test:provider:gemini
pnpm test:provider:ollama
```

Each sends one tiny request and warns that it may count against your subscription usage.
