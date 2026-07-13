# Storytelling integration

OmniResearch's Story Studio transforms **verified research** into engaging video scripts using the
locally installed Claude **storytelling skill** when present. It never replaces evidence
collection, citations, source reconciliation, or fact-checking — storytelling shapes structure,
pacing, hooks, and framing; the facts come only from the research package.

## How the skill is detected and used

A Claude Code skill is a Markdown instruction pack (`SKILL.md` with YAML frontmatter). Claude Code
itself consumes a skill by loading `SKILL.md` into the model's context; OmniResearch does exactly
the same thing:

1. **Detection** (`packages/story-engine/src/skill-detection.ts`): scans `<project>/.claude/skills/`
   then `~/.claude/skills/` for `storytelling/SKILL.md` (and its documented companion
   `viral-hooks/SKILL.md`, which the storytelling skill delegates hook-writing to). Frontmatter is
   parsed; the file's sha256 is recorded as the skill "version". Nothing is hard-coded — paths are
   scanned at runtime, and the report lists exactly where it looked.
2. **Invocation**: on every generation, the skill file is re-read from disk and its instructions
   are embedded verbatim in the provider prompt (method `embedded-skill-instructions`), followed by
   OmniResearch's overriding constraint: craft applies to structure only; every factual element
   must cite `E<n>` refs from the fenced research package.
3. **Recording**: every stage stores a `StoryInvocation` row — provider, skill id + hash, method,
   status, duration, and the research-package version. The UI banner and API status endpoint only
   claim the skill when it was actually detected; a run only claims it when the invocation row says
   so. There is **no silent fallback**: provider failures surface as errors with retry/switch
   options.
4. **Fallback**: if the skill is absent, the same interface runs with OmniResearch's built-in
   structured story-planning instructions (`fallback-instructions`), clearly labeled in the UI.

## Pipeline

Research → Verify → **Blueprint** → **Outline** (+ retention plan) → **Hooks** (safety-gated) →
**Scenes** → **Script** → **Critique** → **Validate**.

- The research package (`research-package.ts`) contains verified evidence with stable `E<n>` refs,
  citation markers, source quality/primary-source status, confidence, disputed claims, unresolved
  questions, prohibited claims, and copyright/safety notes. Its hash is the package version.
- A story cannot be created for a project with no verified evidence.
- Stage order is enforced (no script before a blueprint; no critique before a script).
- Modes: 19 selectable modes plus `auto`, which picks a framework from the evidence shape
  (disputes → investigative; many dated events → timeline; explanatory prompts → plain explanation
  — drama is never forced) and **explains its choice** on the story record.

## Validation (deterministic, cannot be bypassed)

`validation.ts` re-checks every script against the package: factual lines must carry valid `E`
refs (invented refs are high-risk failures); numbers and years must appear in the cited evidence;
long quoted spans must be verbatim; sensational language and unsupported superlatives are flagged;
disputed claims stated as plain fact are flagged; locked facts that a rewrite dropped fail
validation; misleading titles are flagged. A script is only marked `validated` when zero
high-risk issues remain. Hooks pass a separate deterministic gate (`vetHooks`) that rejects
evidence-free or sensational hooks regardless of what the provider produced.

## Data model

`Story` (mode/framework/reason, platform, duration, settings, skill id+hash, package version,
status), `StoryVersion` (versioned artifacts: blueprint/outline/hooks/scenes/script/critique/
validation — all versions kept), `StoryInvocation` (audit of every provider call),
`StoryLockedFact` (user-locked facts). Line-to-claim links live inside script artifact JSON
(`lines[].evidenceRefs`) and are re-derived by validation; scene-to-citation links likewise
(`scenes[].evidenceRefs`). Migration: `prisma/migrations/0003_storytelling`.

## API

- `GET /api/storytelling/status` — detection report (no invocation, no usage consumed)
- `POST /api/projects/:id/stories` · `GET /api/projects/:id/stories` · `GET /api/stories/:id`
- `POST /api/stories/:id/generate/:stage` (blueprint|outline|hooks|scenes|script|critique)
- `POST /api/stories/:id/validate`
- `POST /api/stories/:id/lock-fact` · `DELETE /api/stories/:id/lock-fact/:ref`
- `GET /api/stories/:id/package`

All owner-scoped; all mutations audited.

## Manual test steps

1. `pnpm dev`, sign in, open a project that has completed research → **Story studio**.
2. Check the banner: with `~/.claude/skills/storytelling/SKILL.md` present it shows
   *storytelling skill detected* + path + hash; remove/rename the folder and reload — it must
   switch to *fallback* and list the searched paths.
3. Create a story (mode `auto`) → the structure choice and its reason appear.
4. Generate blueprint → outline → hooks → script; click any `[E<n>]` chip to open the evidence
   drawer; verify hooks show exaggeration risk and any rejected hooks list the reason.
5. Lock an evidence fact, regenerate the script, run **Validate** — if the locked fact vanished,
   validation must flag `locked-fact-missing` and the story shows `needs-review`.
6. Automated: `pnpm --filter @omni/story-engine test` (14 unit tests) and
   `pnpm --filter @omni/api test` (storytelling workflow integration). All provider calls in tests
   use the mock provider — no external calls, no subscription usage.

## Integration status (honest)

- **Skill detection + verbatim instruction loading: fully functional** (this machine currently has
  both `storytelling` and `viral-hooks` installed at user level; the status endpoint reflects
  whatever is installed at request time).
- **Execution quality depends on the active provider**: with Claude Code (or another real
  provider) the skill instructions drive real narrative craft; with the mock provider the
  pipeline runs deterministically for tests/demos and says so in its outputs.
- **Not implemented (honestly deferred)**: multi-duration short-form variant batches, story
  variant comparison UI, scene reordering/undo editor (versions are stored, restore is possible
  via data), retention-plan visualization beyond the outline artifact, and invoking the skill via
  a live `claude` subprocess with the Skill tool enabled (the embedded-instructions method was
  chosen because it is exactly how Claude Code consumes skills, works with every provider, and
  keeps the hardened single-turn CLI security posture).
