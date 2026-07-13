# Security

## Threat model

OmniResearch fetches attacker-controlled web content and passes it near AI tools that hold the
user's subscriptions. The defended threats: SSRF into local/cloud-internal networks, prompt
injection from crawled pages, shell/argument injection into provider CLIs, credential/billing
leakage, cross-user data access, and CSRF.

## SSRF defenses (packages/security)

URLs are validated at **four points**:

1. **Before queuing** — `validateUrlSyntax`: http/https only (no file/ftp/data/javascript/gopher/
   ssh/custom schemes), no embedded credentials, forbidden hostnames (`localhost`, `*.local`,
   `*.internal`, cloud metadata hosts, single-label names), forbidden literal IPs. WHATWG URL
   parsing canonicalizes integer (`http://2130706433`), hex (`0x7f000001`), octal, and short-form
   (`127.1`) IPv4 before the range check, so alternative encodings cannot slip through.
2. **Before navigation** — `validateUrlResolved`: fresh DNS lookup; **every** resolved address must
   be public (blocks loopback, RFC1918, link-local/169.254 metadata, CGNAT, multicast, reserved,
   IPv6 ULA/link-local/multicast, IPv4-mapped and NAT64-embedded forms).
3. **At connect time** — `guardedLookup` is installed as the socket-level DNS resolver for both the
   internal `safeFetch` (undici Agent) and Crawlee's got requests (`dnsLookup`), so a hostname that
   re-resolves to an internal address between check and connect (DNS rebinding) fails at the socket.
4. **Every redirect hop** — `safeFetch` follows redirects manually and re-validates each hop;
   Crawlee requests get a `beforeRedirect` hook doing resolved validation; the final `loadedUrl` is
   re-checked post-response.

Response size is capped while streaming; content types are allowlisted; executables/archives are
rejected by extension and PDF magic bytes are verified. Test fixtures on 127.0.0.1 require the
explicit `OMNI_ALLOW_LOOPBACK_FOR_TESTS=1` escape hatch, which only ever unlocks loopback.

## Prompt-injection isolation (packages/security/src/prompt-safety.ts)

- Crawled text enters prompts only inside fenced blocks delimited by a **run-unique token**
  (SHA-256-derived), with fence-imitating text inside excerpts neutralized.
- Every provider prompt separates trusted instructions from the fenced DATA section, with an
  explicit data-only preamble.
- Instruction-like content (ignore-previous-instructions, run-command, reveal-secrets, fake role
  tags…) is detected and **flagged** — on the source record, the run log, and the fence header —
  but never obeyed.
- The application, not the model, performs all crawling, DB access, exports, and job creation.
  CLI adapters grant no tools: Claude Code runs in single-turn print mode, Codex in read-only
  sandbox, Gemini plain stdin mode; Ollama is a bare completion API. Provider output is parsed as
  JSON against zod schemas — nothing in it is executed.
- Defense of last resort: even if a model is successfully injected, fabricated evidence is dropped
  by verbatim verification, and citation verification re-checks every marker against stored
  snapshots.

Automated tests crawl a fixture page containing a real injection payload and assert it is flagged,
inert, and absent from the report (`apps/worker/test/pipeline.integration.test.ts`).

## Provider process safety (packages/ai-providers/src/process-runner.ts)

- `spawn(executable, args, { shell: false })` with fixed argument templates; prompts via stdin —
  user text never becomes an argument or a shell string.
- Executable allowlist (only registered provider binaries).
- **Filtered environment**: a small allowlist (PATH, HOME, TEMP, Windows system vars). Billing
  variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, …) are
  stripped unconditionally so a subscription CLI can never silently switch to API billing; their
  presence triggers a visible warning in provider status.
- Isolated per-invocation temp workspace (cwd + TMP), deleted afterwards.
- Input/output size caps, hard timeout, process-tree kill (`taskkill /T /F` on Windows, process
  group kill on POSIX), global concurrency limit, secret redaction on captured output.

## Web/API security

- Sessions: random 256-bit tokens stored **hashed** (SHA-256) with expiry; cookies are httpOnly,
  SameSite=Lax, Secure in production. Passwords: bcrypt (cost 11), constant-shape login errors.
- CSRF: SameSite=Lax + a required custom `x-omni-csrf` header on all mutations (HTML forms can't
  set custom headers cross-site).
- AuthZ: every project/run/source/lesson access re-checks ownership server-side; "not yours" is
  indistinguishable from "not found". Nothing sensitive is trusted from the client (owner ids,
  provider capabilities, quality scores, completion states are all server-derived).
- Zod validation on every route; typed errors `{code, message, details?, requestId}`; stack traces
  suppressed in production; rate limiting globally and stricter on auth; helmet security headers;
  audit log (`AuditLog`) for auth, project, run, provider, and export actions with request ids.
- API and worker bind to **127.0.0.1** — the local provider bridge is not reachable from the
  network, one user's subscription cannot serve remote strangers.
- Logs redact cookies/authorization headers and common secret formats (`redactSecrets`), and never
  include passwords, tokens, or CLI credential files.

## Privacy & retention

- Retention: stored source content expires after `SOURCE_CONTENT_RETENTION_DAYS` (default 30);
  hourly worker cleanup purges snapshots while keeping metadata + citation locators auditable.
  `STORE_FULL_SOURCE_CONTENT=false` (default) keeps only bounded text.
- Deletion: projects cascade-delete sources/evidence/reports; `DELETE /api/auth/account` removes
  the user and everything owned. Exports are available before deletion.

## Manual security checklist

- [ ] `pnpm test` — SSRF, redirect, robots, limits, injection, env-filter, authz suites pass
- [ ] `pnpm verify:crawlee` — origin + pin verified
- [ ] `.env` has a strong `AUTH_SECRET` before any non-localhost exposure
- [ ] API/worker bound to 127.0.0.1 (default) or behind authenticated reverse proxy (see deployment)
- [ ] No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` in the service environment, or
      accept the visible warning knowing they are still never forwarded
- [ ] `docker compose ps` volumes on an encrypted disk if research data is sensitive
- [ ] Review `AuditLog` periodically; entries carry request ids and IPs
