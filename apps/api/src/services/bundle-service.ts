import { createHash } from "node:crypto";
import { getPrisma, recordTimelineEvent } from "@omni/database";
import { newId } from "@omni/shared";
import type { ImportPreview } from "./import-service.js";

/**
 * Portable project bundles (`.omni.json`).
 *
 * A bundle carries a project's research graph with BUNDLE-SCOPED identifiers
 * only — never database IDs, owners, secrets, sessions, env vars, or machine
 * paths. Import ALWAYS creates a NEW project owned by the importing user and
 * rebuilds relationships from the bundle-scoped ID map, so a bundle can never
 * overwrite an existing project or forge ownership. A manifest checksum over
 * the canonical data section detects tampering/corruption.
 */

export const BUNDLE_MARKER = "__omni_bundle__";
export const BUNDLE_SCHEMA_VERSION = 1;

type BundleSource = {
  bid: string;
  url: string;
  finalUrl: string | null;
  normalizedUrl: string;
  title: string | null;
  author: string | null;
  publisher: string | null;
  classification: string;
  qualityScore: number;
  scoreReasons: unknown;
  publishedAt: string | null;
  retrievedAt: string | null;
  contentType: string | null;
  crawlMethod: string | null;
  status: string;
  contentHash: string | null;
  duplicateOfBid: string | null;
  excerpt: string | null;
  snapshot?: { contentText: string; pageTexts: unknown | null } | null;
};

type Bundle = {
  [BUNDLE_MARKER]: string;
  manifest: {
    schemaVersion: number;
    appVersion: string;
    exportedAt: string;
    checksum: string;
    includesSnapshots: boolean;
    counts: Record<string, number>;
  };
  data: {
    project: { title: string; mode: string; prompt: string; citationStyle: string; gradeLevel: string | null };
    topics: { bid: string; name: string; order: number }[];
    sources: BundleSource[];
    evidence: {
      bid: string;
      sourceBid: string;
      claim: string;
      evidenceText: string;
      sourceLocation: string | null;
      pageNumber: number | null;
      relevanceScore: number;
      evidenceStrength: string;
      evidenceType: string;
    }[];
    claims: {
      bid: string;
      text: string;
      statementKind: string;
      verificationStatus: string | null;
      statusExplanation: string | null;
      links: { evidenceBid: string; stance: string }[];
    }[];
    notes: {
      bid: string;
      title: string | null;
      contentMd: string;
      kind: string;
      tags: unknown;
      pinned: boolean;
      quotedText: string | null;
      sourceLocation: string | null;
      sourceBid: string | null;
      claimBid: string | null;
      evidenceBid: string | null;
      reportBid: string | null;
    }[];
    reports: {
      bid: string;
      title: string;
      citationStyle: string;
      methodology: string | null;
      limitations: string | null;
      verified: boolean;
      sections: { kind: string; title: string; contentMd: string; order: number }[];
      citations: { marker: number; sourceBid: string; evidenceBid: string | null; quotedText: string | null; locator: string | null; pageNumber: number | null; verified: boolean; verifyNote: string | null }[];
    }[];
  };
};

/** Deterministic canonical JSON (sorted keys) for a stable checksum. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function checksumOf(data: unknown): string {
  // Normalize through JSON first so the hash matches what a re-imported
  // bundle sees (JSON.stringify drops `undefined` keys); the checksum must be
  // stable across the export → file → import round trip.
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(data)))).digest("hex");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function buildBundle(projectId: string, options: { includeSnapshots: boolean }): Promise<{ json: string; filename: string; counts: Record<string, number> }> {
  const prisma = getPrisma();
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const topics = await prisma.topic.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  const sources = await prisma.source.findMany({ where: { projectId } });
  const snapshotBySource = new Map<string, { contentText: string; pageTexts: unknown }>();
  if (options.includeSnapshots) {
    const snaps = await prisma.sourceSnapshot.findMany({
      where: { source: { projectId }, kind: "main-text" },
      select: { sourceId: true, contentText: true, pageTexts: true },
    });
    for (const snap of snaps) if (!snapshotBySource.has(snap.sourceId)) snapshotBySource.set(snap.sourceId, { contentText: snap.contentText, pageTexts: snap.pageTexts });
  }
  const evidence = await prisma.evidence.findMany({ where: { projectId } });
  const claims = await prisma.claim.findMany({ where: { projectId }, include: { evidence: true } });
  const notes = await prisma.note.findMany({ where: { projectId } });
  const reports = await prisma.report.findMany({ where: { projectId }, include: { sections: { orderBy: { order: "asc" } }, citations: { orderBy: { marker: "asc" } } } });

  // Assign bundle-scoped IDs; build maps from db-id -> bid.
  const bid = (prefix: string, i: number) => `b:${prefix}:${i}`;
  const srcBid = new Map(sources.map((s, i) => [s.id, bid("src", i)]));
  const topBid = new Map(topics.map((t, i) => [t.id, bid("top", i)]));
  const evBid = new Map(evidence.map((e, i) => [e.id, bid("evd", i)]));
  const clmBid = new Map(claims.map((c, i) => [c.id, bid("clm", i)]));
  const repBid = new Map(reports.map((r, i) => [r.id, bid("rep", i)]));

  const data: Bundle["data"] = {
    project: { title: project.title, mode: project.mode, prompt: project.prompt, citationStyle: project.citationStyle, gradeLevel: project.gradeLevel },
    topics: topics.map((t) => ({ bid: topBid.get(t.id)!, name: t.name, order: t.order })),
    sources: sources.map((s) => ({
      bid: srcBid.get(s.id)!,
      url: s.url,
      finalUrl: s.finalUrl,
      normalizedUrl: s.normalizedUrl,
      title: s.title,
      author: s.author,
      publisher: s.publisher,
      classification: s.classification,
      qualityScore: s.qualityScore,
      scoreReasons: s.scoreReasons,
      publishedAt: s.publishedAt?.toISOString() ?? null,
      retrievedAt: s.retrievedAt?.toISOString() ?? null,
      contentType: s.contentType,
      crawlMethod: s.crawlMethod,
      status: s.status,
      contentHash: s.contentHash,
      duplicateOfBid: s.duplicateOfId ? srcBid.get(s.duplicateOfId) ?? null : null,
      excerpt: s.excerpt,
      snapshot: options.includeSnapshots ? snapshotBySource.get(s.id) ?? null : undefined,
    })),
    evidence: evidence.map((e) => ({
      bid: evBid.get(e.id)!,
      sourceBid: srcBid.get(e.sourceId)!,
      claim: e.claim,
      evidenceText: e.evidenceText,
      sourceLocation: e.sourceLocation,
      pageNumber: e.pageNumber,
      relevanceScore: e.relevanceScore,
      evidenceStrength: e.evidenceStrength,
      evidenceType: e.evidenceType,
    })),
    claims: claims.map((c) => ({
      bid: clmBid.get(c.id)!,
      text: c.text,
      statementKind: c.statementKind,
      verificationStatus: c.verificationStatus,
      statusExplanation: c.statusExplanation,
      links: c.evidence.filter((l) => evBid.has(l.evidenceId)).map((l) => ({ evidenceBid: evBid.get(l.evidenceId)!, stance: l.stance })),
    })),
    notes: notes.map((n) => ({
      bid: `b:note:${n.id}`,
      title: n.title,
      contentMd: n.contentMd,
      kind: n.kind,
      tags: n.tags,
      pinned: n.pinned,
      quotedText: n.quotedText,
      sourceLocation: n.sourceLocation,
      sourceBid: n.sourceId ? srcBid.get(n.sourceId) ?? null : null,
      claimBid: n.claimId ? clmBid.get(n.claimId) ?? null : null,
      evidenceBid: n.evidenceId ? evBid.get(n.evidenceId) ?? null : null,
      reportBid: n.reportId ? repBid.get(n.reportId) ?? null : null,
    })),
    reports: reports.map((r) => ({
      bid: repBid.get(r.id)!,
      title: r.title,
      citationStyle: r.citationStyle,
      methodology: r.methodology,
      limitations: r.limitations,
      verified: Boolean(r.verifiedAt),
      sections: r.sections.map((sec) => ({ kind: sec.kind, title: sec.title, contentMd: sec.contentMd, order: sec.order })),
      citations: r.citations
        .filter((cit) => srcBid.has(cit.sourceId))
        .map((cit) => ({ marker: cit.marker, sourceBid: srcBid.get(cit.sourceId)!, evidenceBid: cit.evidenceId ? evBid.get(cit.evidenceId) ?? null : null, quotedText: cit.quotedText, locator: cit.locator, pageNumber: cit.pageNumber, verified: cit.verified, verifyNote: cit.verifyNote })),
    })),
  };

  const counts = {
    sources: data.sources.length,
    evidence: data.evidence.length,
    claims: data.claims.length,
    notes: data.notes.length,
    reports: data.reports.length,
    topics: data.topics.length,
  };
  const bundle: Bundle = {
    [BUNDLE_MARKER]: "omni-research",
    manifest: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      appVersion: "0.1.0",
      exportedAt: new Date().toISOString(),
      checksum: checksumOf(data),
      includesSnapshots: options.includeSnapshots,
      counts,
    },
    data,
  };
  const safe = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "project";
  return { json: JSON.stringify(bundle, null, 2), filename: `${safe}.omni.json`, counts };
}

// ---------------------------------------------------------------------------
// Import (preview + commit)
// ---------------------------------------------------------------------------

function parseBundle(content: string): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Bundle is not valid JSON");
  }
  const bundle = parsed as Bundle;
  if (!bundle || bundle[BUNDLE_MARKER] !== "omni-research") throw new Error("Not an OmniResearch bundle");
  if (bundle.manifest?.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle schema version ${bundle.manifest?.schemaVersion} (this build reads version ${BUNDLE_SCHEMA_VERSION})`);
  }
  const recomputed = checksumOf(bundle.data);
  if (recomputed !== bundle.manifest.checksum) {
    throw new Error("Bundle checksum mismatch — the file is corrupted or was modified after export");
  }
  return bundle;
}

export function previewBundle(content: string): ImportPreview {
  const bundle = parseBundle(content);
  const warnings: string[] = [];
  if (!bundle.manifest.includesSnapshots) warnings.push("Metadata-only bundle: source snapshots are NOT included; citation re-verification will be limited until sources are re-crawled.");
  return {
    kind: "omni-bundle",
    items: [
      {
        index: 0,
        title: bundle.data.project.title,
        detail: `imports into a NEW project: ${bundle.manifest.counts.sources} sources, ${bundle.manifest.counts.evidence} evidence, ${bundle.manifest.counts.claims} claims, ${bundle.manifest.counts.notes} notes, ${bundle.manifest.counts.reports} reports`,
      },
    ],
    warnings,
    stats: { manifest: bundle.manifest as unknown as Record<string, unknown> },
  };
}

export async function importBundle(_currentProjectId: string, userId: string, content: string, jobId: string): Promise<{ newProjectId: string; projectTitle: string; imported: number }> {
  const prisma = getPrisma();
  const bundle = parseBundle(content);
  const d = bundle.data;
  let imported = 0;

  // NEW project owned by the importer — never overwrite an existing project.
  const project = await prisma.project.create({
    data: {
      id: newId("prj"),
      ownerId: userId,
      title: `${d.project.title} (imported)`.slice(0, 200),
      mode: d.project.mode,
      prompt: d.project.prompt,
      citationStyle: d.project.citationStyle,
      gradeLevel: d.project.gradeLevel ?? undefined,
    },
  });
  const projectId = project.id;

  // Synthetic run: Evidence.runId and Report.runId are foreign keys.
  const run = await prisma.researchRun.create({
    data: { id: newId("run"), projectId, status: "completed", stage: "complete", providerUsed: "imported-bundle", finishedAt: new Date() },
  });

  const idMap = new Map<string, string>(); // bundle-scoped bid -> new db id

  // Topics
  for (const t of d.topics) {
    const created = await prisma.topic.create({ data: { id: newId("top"), projectId, name: t.name.slice(0, 190), order: t.order } });
    idMap.set(t.bid, created.id);
  }

  // Sources (two passes for duplicateOf self-references)
  for (const s of d.sources) {
    const created = await prisma.source.create({
      data: {
        id: newId("src"),
        projectId,
        url: s.url,
        finalUrl: s.finalUrl ?? undefined,
        normalizedUrl: `${s.normalizedUrl}#bundle-${jobId}`.slice(0, 2040), // avoid clashing uniqueness within the new project
        title: s.title ?? undefined,
        author: s.author ?? undefined,
        publisher: s.publisher ?? undefined,
        classification: s.classification,
        qualityScore: s.qualityScore,
        scoreReasons: (s.scoreReasons as object) ?? [],
        publishedAt: s.publishedAt ? new Date(s.publishedAt) : undefined,
        retrievedAt: s.retrievedAt ? new Date(s.retrievedAt) : undefined,
        contentType: s.contentType ?? undefined,
        crawlMethod: s.crawlMethod ?? undefined,
        status: s.status,
        contentHash: s.contentHash ?? undefined,
        excerpt: s.excerpt ?? undefined,
        discoveredBy: "import",
      },
    });
    idMap.set(s.bid, created.id);
    imported++;
    if (s.snapshot?.contentText) {
      await prisma.sourceSnapshot.create({
        data: { id: newId("snap"), sourceId: created.id, kind: "main-text", contentText: s.snapshot.contentText.slice(0, 500_000), pageTexts: (s.snapshot.pageTexts as object) ?? undefined, bytes: Buffer.byteLength(s.snapshot.contentText) },
      });
    }
  }
  for (const s of d.sources) {
    if (s.duplicateOfBid && idMap.has(s.duplicateOfBid) && idMap.has(s.bid)) {
      await prisma.source.update({ where: { id: idMap.get(s.bid)! }, data: { duplicateOfId: idMap.get(s.duplicateOfBid)! } });
    }
  }

  // Evidence
  for (const e of d.evidence) {
    const sourceId = idMap.get(e.sourceBid);
    if (!sourceId) continue; // bundle-scoped integrity: never dangle
    const created = await prisma.evidence.create({
      data: {
        id: newId("evd"),
        projectId,
        runId: run.id,
        sourceId,
        claim: e.claim,
        evidenceText: e.evidenceText,
        sourceLocation: e.sourceLocation ?? undefined,
        pageNumber: e.pageNumber ?? undefined,
        relevanceScore: e.relevanceScore,
        evidenceStrength: e.evidenceStrength,
        evidenceType: e.evidenceType,
      },
    });
    idMap.set(e.bid, created.id);
    imported++;
  }

  // Claims + claim-evidence links
  for (const c of d.claims) {
    const created = await prisma.claim.create({
      data: { id: newId("clm"), projectId, text: c.text, statementKind: c.statementKind, verificationStatus: c.verificationStatus ?? undefined, statusExplanation: c.statusExplanation ?? undefined },
    });
    idMap.set(c.bid, created.id);
    imported++;
    for (const link of c.links) {
      const evidenceId = idMap.get(link.evidenceBid);
      if (!evidenceId) continue;
      await prisma.claimEvidence.create({ data: { id: newId("ce"), claimId: created.id, evidenceId, stance: link.stance } });
    }
  }

  // Reports + sections + citations
  for (const r of d.reports) {
    const report = await prisma.report.create({
      data: { id: newId("rep"), projectId, runId: run.id, title: r.title, citationStyle: r.citationStyle, methodology: r.methodology ?? undefined, limitations: r.limitations ?? undefined, verifiedAt: r.verified ? new Date() : undefined },
    });
    idMap.set(r.bid, report.id);
    imported++;
    for (const [i, sec] of r.sections.entries()) {
      await prisma.reportSection.create({ data: { id: newId("sec"), reportId: report.id, kind: sec.kind, title: sec.title.slice(0, 290), contentMd: sec.contentMd, order: sec.order ?? i } });
    }
    for (const cit of r.citations) {
      const sourceId = idMap.get(cit.sourceBid);
      if (!sourceId) continue;
      await prisma.citation.create({
        data: { id: newId("cit"), reportId: report.id, sourceId, evidenceId: cit.evidenceBid ? idMap.get(cit.evidenceBid) ?? undefined : undefined, marker: cit.marker, quotedText: cit.quotedText ?? undefined, locator: cit.locator ?? undefined, pageNumber: cit.pageNumber ?? undefined, verified: cit.verified, verifyNote: cit.verifyNote ?? undefined },
      });
    }
  }

  // Notes (link only to entities that came in the same bundle)
  for (const n of d.notes) {
    await prisma.note.create({
      data: {
        id: newId("note"),
        projectId,
        title: n.title ?? undefined,
        contentMd: n.contentMd,
        kind: n.kind,
        tags: (n.tags as object) ?? [],
        pinned: n.pinned,
        quotedText: n.quotedText ?? undefined,
        sourceLocation: n.sourceLocation ?? undefined,
        sourceId: n.sourceBid ? idMap.get(n.sourceBid) ?? undefined : undefined,
        claimId: n.claimBid ? idMap.get(n.claimBid) ?? undefined : undefined,
        evidenceId: n.evidenceBid ? idMap.get(n.evidenceBid) ?? undefined : undefined,
        reportId: n.reportBid ? idMap.get(n.reportBid) ?? undefined : undefined,
      },
    });
    imported++;
  }

  await recordTimelineEvent(prisma, { projectId, type: "project-created", summary: `Project imported from a portable bundle (${imported} entities)`, entityType: "import", entityId: jobId });
  return { newProjectId: projectId, projectTitle: project.title, imported };
}
