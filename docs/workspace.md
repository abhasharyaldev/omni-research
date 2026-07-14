# Research Workspace (notebook, import, timeline, exports)

## Research Notebook
Project-level notes (`/projects/:id/notebook`): Markdown content, titles, tags, pinning,
archiving, search/filter/sort, and links to sources, claims, evidence, and reports (validated
server-side — cross-project links are rejected). Quote notes preserve the verbatim selection and
source location. "Promote to claim" turns a note into a tracked claim in the ledger. Autosave is
debounced (900 ms), flushed on navigation, and shows Saving / Saved / Save failed / Offline; notes
are covered by the existing full-text search (`Ctrl/Cmd+K`).

## Universal Import (v1 — text formats)
`/projects/:id/import`. Supported now: **pasted text, URL lists, Markdown, plain text, CSV, TSV**
(type auto-detected or chosen). Workflow: parse → preview (items, warnings, CSV column stats with
inferred types and missing-value counts) → confirm → per-item results → links to created sources.

Security (every import is untrusted): 5 MB size cap; binary-signature rejection (executables,
archives, PDFs claimed as text — extensions and MIME are never trusted); NUL-byte rejection;
filename sanitization (path traversal stripped); SSRF policy applied to every URL (private,
loopback, link-local, metadata addresses are blocked in preview and skipped on confirm);
spreadsheet-formula injection neutralized in CSV/TSV content; checksum idempotency (identical
payload → same job, no duplicates); content-hash dedup against existing sources; ownership
enforced on every job/preview/confirm/cancel endpoint. Imported URLs become metadata-only sources
crawled by the next research run through the full crawl-safety pipeline; imported text becomes a
local source snapshot classified `user-generated` with an honest score reason.

Provenance stored per item (`ImportItem.provenanceJson`): import job, importing user, timestamp,
original filename, parser + version, byte size, sha256 checksum, per-format stats, and a
`pastedByUser` flag for pasted text.

## Research Timeline
`/projects/:id/timeline`: project-created, run-started/completed/failed, note-created,
claim-created, report/export/story/import events — with actor (user vs system), entity links,
type filter, and incremental loading. Events store compact summaries and stable references, never
document bodies. Recording never breaks the operation it describes.

## Real DOCX and PDF export
Report export menu now includes **Word (.docx)** and **PDF (.pdf)** — genuine files, not renamed
HTML: DOCX via the `docx` package (OOXML zip, verified by `PK` signature in tests), PDF via
`pdfkit` (pure JS, built-in Helvetica — **no system dependency**; verified by `%PDF-` header).
Both include title, author, date, verification notice, headings, paragraphs, page numbers, and the
citation bibliography in the project's citation style. Untrusted text is emitted as literal runs
only. The export layer is modular (`packages/research-engine/src/binary-exporters.ts`).

## Deferred (interfaces planned, honestly not built)
- **PDF/DOCX/BibTeX/RIS/CSL-JSON import, archives, OCR** — `ImportJob.kind` and the service
  parser registry are the extension points; binary parsing needs `unpdf` (already vendored for
  crawling) and a DOCX XML reader; next step: add `kind: "pdf"` accepting base64 with signature
  check `%PDF`, reuse `extractPdf` from @omni/crawler.
- **Portable bundles (.omni.json)** — planned as an ImportJob kind + export builder; schema
  version + manifest + checksums; import always creates a new project owned by the importer.
- **Browser extension** — server contract sketch: `POST /api/capture` (session-authenticated,
  same-origin policy, payload-capped, dedup by normalized URL, provenance `discoveredBy:
  "extension"`); no unauthenticated local endpoint will be exposed.
- **RIS / CSL-JSON bibliography, .omni.zip archives, multi-file jobs, OCR** — same import service extension point (add a kind + parser); RIS/CSL are structurally similar to BibTeX.
- **Evidence graph, dataset/paper mode, school-mode expansion, story-studio variants** — data
  already supports them (relationships persisted); UI work pending.

## Video integration (planned — Phase 3, not yet built)
The video engine will integrate [bradautomates/claude-video](https://github.com/bradautomates/claude-video)
(MIT) as an optional, versioned, provider-neutral extraction stage (yt-dlp + ffmpeg + captions +
frames), audited and **pinned**; inspected upstream commit: `83da59fa78c3eee9e20f515fe75c438bb5166efd`.
Despite the upstream name, extraction artifacts (transcript segments, frames, metadata) will be
analyzable by ANY configured provider whose adapter declares the needed capabilities
(`imageInput` for frames; text for transcripts) — Claude is never required. Multilingual
translation (including the unofficial, interactive Google Translate Web flow), local Whisper
transcription, portable bundles, the evidence graph, dataset/paper/school modes, and the browser
extension remain planned; none are presented as complete.
