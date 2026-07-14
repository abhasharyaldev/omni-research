# Provider-neutral video engine (Phase 3)

OmniResearch analyzes video by separating **deterministic media extraction** from **AI analysis**,
so the same neutral artifacts work with any provider. Despite the upstream name "claude-video," the
feature is not Claude-specific.

## Two-stage design

**Stage A — extraction (deterministic, no AI).** Produces neutral artifacts: timestamped transcript
segments and (optionally) extracted frame paths.
- **Caption-first, no binaries:** paste an SRT/WebVTT file → exact cue IDs, timestamps, speaker
  labels, and language are preserved as `TranscriptSegment` rows. This path always works and is what
  the deterministic CI tests exercise.
- **URL extraction (optional tooling):** wraps the pinned upstream
  [bradautomates/claude-video](https://github.com/bradautomates/claude-video) `watch.py`
  (MIT, © Bradley Bonanno) — commit `83da59fa78c3eee9e20f515fe75c438bb5166efd` — via a hardened
  subprocess: `spawn` with `shell:false`, a fixed argument template (`packages/video-engine/src/args.ts`),
  a python-interpreter allowlist, an isolated temp working directory, output-size cap, timeout, and
  process-tree termination. The environment is filtered so **no API keys reach the tool** — remote
  Whisper is never triggered silently. Order: manual captions → auto captions → local Whisper
  (opt-in) → frames-only. If yt-dlp/ffmpeg/watch.py are absent, the engine reports a clear reason and
  the subtitle path still works.

**Stage B — analysis (provider-neutral, capability-gated).** `planVideoAnalysis()` prepares the exact
payload for the chosen provider: it includes frames **only** when the provider's adapter declares
`imageInput: true`. A text-only model gets a transcript-only plan and an honest scope note ("the
selected model is TEXT-ONLY … never claim to have viewed the video"). The provider is never switched
silently, and the model is never told it saw frames it did not.

## Detail modes
`transcript` (no frames), `efficient` (~24), `balanced` (~60), `token-burner` (~100, hard max 100).
Start/end windows, max-frames, resolution, and fps are all clamped in the pure arg-builder.

## Provenance (per `VideoAsset`)
source URL/kind, caption source (manual/auto/whisper/subtitle-import/frames-only), language, detail
mode, frame count, engine name + version + pinned commit, `dataLeftDevice` flag, warnings, and a
content checksum. Every `TranscriptSegment` keeps its exact text and a checksum. Citations should use
timestamps, e.g. `Video title, 00:03:14`.

## Security
- SSRF policy on every video URL (private/loopback/metadata hosts blocked).
- Local file paths are never accepted from the browser; only http(s) URLs.
- No shell, fixed args, allowlisted interpreter, isolated temp dir, size/time/frame caps, tree-kill.
- Filtered env → audio/frames never uploaded to a remote provider without explicit opt-in.
- Ownership enforced on every video endpoint.

## API
`GET /api/video/status` · `GET /api/projects/:id/videos` · `GET /api/videos/:id` ·
`POST /api/projects/:id/videos/from-subtitle` · `POST /api/projects/:id/videos/from-url` ·
`POST /api/videos/:id/analyze` · `DELETE /api/videos/:id`.

## Manual setup for URL extraction (optional)
Install the pinned tooling: `/plugin marketplace add bradautomates/claude-video` then
`/plugin install watch@claude-video` (or `npx skills add bradautomates/claude-video -g`), plus
`yt-dlp` and `ffmpeg` on PATH. Point `CLAUDE_VIDEO_DIR`, `YT_DLP_PATH`, `FFMPEG_PATH`, `PYTHON_PATH`
at custom locations if needed. Local no-key Whisper (whisper.cpp / faster-whisper) is the documented
next step for the offline transcript fallback; until wired, captions/subtitles are the no-key path.

## Deferred (honest)
- Local no-key Whisper transcription wiring (whisper.cpp/faster-whisper) — the `--no-whisper` gate and
  provenance fields exist; next step is a `WhisperRunner` invoked from `runVideoExtraction` when
  captions are absent and the user opted into local transcription.
- Persisting frame BYTES for multimodal analysis (only frame COUNT/paths are captured this slice, so
  `wantFrames` currently resolves to transcript-only even for multimodal providers until frames are
  stored as artifacts).
