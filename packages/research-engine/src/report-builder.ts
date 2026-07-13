import { newId, type ProviderId } from "@omni/shared";
import { ProviderError, type SubscriptionAIProvider } from "@omni/ai-providers";
import {
  SYNTHESIS_SCHEMA_DESCRIPTION,
  synthesisOutputSchema,
  type PlanOutput,
} from "./schemas.js";
import { containsVerbatim } from "./text-utils.js";
import type { Counters, PipelineDeps } from "./pipeline.js";

type EvidenceRowLite = {
  id: string;
  sourceId: string;
  claim: string;
  evidenceText: string;
  subquestionId?: string;
  sourceTitle: string;
  pageNumber?: number;
  sourceLocation?: string;
};

export type DisagreementForReport = {
  topic: string;
  conflictPoint: string;
  kind: string;
  resolution: string;
  assessment: string;
  confidenceNote: string;
  evidenceIdA: string;
  evidenceIdB: string;
};

export type SynthesizeArgs = {
  deps: PipelineDeps;
  runId: string;
  project: { id: string; title: string; citationStyle: string; mode: string };
  provider: SubscriptionAIProvider;
  providerId: ProviderId;
  plan: PlanOutput;
  subquestionRows: { id: string }[];
  evidenceRows: EvidenceRowLite[];
  counters: Counters;
  discoveryNotes: string[];
  /** Reconciled source disagreements; rendered as a dedicated section. */
  disagreements?: DisagreementForReport[];
};

/**
 * Stage 8 (synthesis) and Stage 9 (mandatory citation verification).
 *
 * Verification is not optional: every [n] marker in the report must map to a
 * numbered evidence record whose excerpt exists verbatim in the stored source
 * snapshot. Markers that fail are removed; lines left with no verified
 * support are removed and reported in the Limitations section.
 */
export async function synthesizeAndVerify(args: SynthesizeArgs): Promise<string> {
  const { deps, runId, project, provider, providerId, plan, evidenceRows, counters } = args;
  const { prisma } = deps;

  await deps.emit("writing-report", `Writing report with ${provider.displayName}`, counters, {
    provider: providerId,
  });

  const markers = evidenceRows.map((row, index) => ({ marker: index + 1, row }));
  const subquestionIndexById = new Map(args.subquestionRows.map((s, i) => [s.id, i]));

  let synthesis;
  try {
    synthesis = await provider.generateStructured(
      {
        requestId: `synthesis-${runId}`,
        taskKind: "synthesis",
        instructions: [
          `Write a structured research report. Main question: ${plan.mainQuestion}`,
          `Report outline suggestion: ${plan.outline.join(" | ")}`,
          "Rules:",
          "- Support every factual statement with a bracketed citation marker [n] from the numbered evidence list.",
          "- Never invent a marker; only use the numbers provided.",
          "- Clearly separate fact, opinion, inference, and uncertainty (label inferences as such).",
          "- If evidence is missing for a subquestion, say so explicitly instead of filling the gap.",
          "- Note where sources agree and disagree.",
        ].join("\n"),
        data: markers
          .map(
            ({ marker, row }) =>
              `[${marker}] claim: ${row.claim}\n    excerpt: "${row.evidenceText}"\n    source: ${row.sourceTitle}`
          )
          .join("\n"),
        context: {
          mainQuestion: plan.mainQuestion,
          subquestions: plan.subquestions,
          mode: project.mode,
          evidence: markers.map(({ marker, row }) => ({
            marker,
            claim: row.claim,
            evidenceText: row.evidenceText.slice(0, 300),
            sourceTitle: row.sourceTitle,
            subquestionIndex: row.subquestionId !== undefined ? subquestionIndexById.get(row.subquestionId) : undefined,
          })),
        },
        schemaDescription: SYNTHESIS_SCHEMA_DESCRIPTION,
      },
      synthesisOutputSchema
    );
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new Error(
        `AI provider "${providerId}" failed during synthesis (${err.code}): ${err.message}. ` +
          `Sources and ${evidenceRows.length} evidence records are saved; regenerate the report after fixing the provider.`
      );
    }
    throw err;
  }

  // Append the deterministic disagreement section (built from reconciled
  // conflicts, cited with the same [n] markers so verification applies).
  const markerByEvidenceId = new Map(markers.map(({ marker, row }) => [row.id, marker]));
  if (args.disagreements && args.disagreements.length > 0) {
    const lines: string[] = [
      "Sources in this project's library disagree on the points below. Each disagreement is reported honestly: when the collected material does not resolve a conflict, it is marked **unresolved** rather than papered over.",
      "",
    ];
    for (const item of args.disagreements) {
      const markerA = markerByEvidenceId.get(item.evidenceIdA);
      const markerB = markerByEvidenceId.get(item.evidenceIdB);
      const cite = [markerA, markerB].filter((m): m is number => m !== undefined).map((m) => `[${m}]`).join("");
      lines.push(
        `### ${item.topic}`,
        `- **Point of conflict:** ${item.conflictPoint}${cite}`,
        `- **Type:** ${item.kind} · **Resolution:** ${item.resolution.replace(/-/g, " ")}`,
        `- **Assessment:** ${item.assessment}`,
        ...(item.confidenceNote ? [`- **Uncertainty:** ${item.confidenceNote}`] : []),
        ""
      );
    }
    synthesis.sections.push({
      kind: "perspectives",
      title: "Where sources disagree",
      contentMd: lines.join("\n"),
    });
  }

  // ---- Stage 9: verify citations -------------------------------------------
  await deps.emit("verifying-citations", "Verifying every citation against stored source content", counters);

  const markerMap = new Map(markers.map(({ marker, row }) => [marker, row]));
  const verifiedMarkers = new Map<number, { row: EvidenceRowLite; verifyNote: string; verified: boolean }>();
  const verificationNotes: string[] = [];

  for (const { marker, row } of markers) {
    const snapshot = await prisma.sourceSnapshot.findFirst({
      where: { sourceId: row.sourceId, kind: "main-text" },
      orderBy: { createdAt: "desc" },
    });
    const source = await prisma.source.findUnique({ where: { id: row.sourceId } });
    let verified = false;
    let note: string;
    if (!source || source.status !== "retrieved") {
      note = "source record missing or not retrieved";
    } else if (snapshot && containsVerbatim(snapshot.contentText, row.evidenceText)) {
      verified = true;
      note = "excerpt found verbatim in stored source content";
    } else if (snapshot) {
      note = "excerpt NOT found in stored source content";
    } else if (containsVerbatim(source.excerpt ?? "", row.evidenceText)) {
      verified = true;
      note = "excerpt found in stored source excerpt (excerpt-only retention)";
    } else {
      note = "no stored content available to verify against";
    }
    verifiedMarkers.set(marker, { row, verifyNote: note, verified });
  }

  const cleanedSections: { kind: string; title: string; contentMd: string }[] = [];
  let removedLines = 0;
  let removedMarkers = 0;

  for (const section of synthesis.sections) {
    const lines = section.contentMd.split("\n");
    const keptLines: string[] = [];
    for (const line of lines) {
      const markerRefs = [...line.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
      if (markerRefs.length === 0) {
        keptLines.push(line);
        continue;
      }
      const valid = markerRefs.filter((m) => verifiedMarkers.get(m)?.verified);
      const invalid = markerRefs.filter((m) => !verifiedMarkers.get(m)?.verified);
      if (valid.length === 0) {
        // A cited line with no verified support is removed, not silently kept.
        removedLines++;
        removedMarkers += invalid.length;
        continue;
      }
      let cleaned = line;
      for (const m of invalid) {
        cleaned = cleaned.split(`[${m}]`).join("");
        removedMarkers++;
      }
      keptLines.push(cleaned);
    }
    const contentMd = keptLines.join("\n").trim();
    if (contentMd) cleanedSections.push({ kind: section.kind, title: section.title, contentMd });
  }

  if (removedLines > 0 || removedMarkers > 0) {
    verificationNotes.push(
      `${removedMarkers} citation marker(s) failed verification and were removed; ${removedLines} unsupported line(s) were removed entirely.`
    );
  }

  const usedMarkers = new Set<number>();
  for (const section of cleanedSections) {
    for (const match of section.contentMd.matchAll(/\[(\d{1,3})\]/g)) {
      const m = Number(match[1]);
      if (verifiedMarkers.get(m)?.verified) usedMarkers.add(m);
    }
  }

  // ---- Persist report -------------------------------------------------------
  const limitations = [
    "## How this research was performed",
    `Discovery coverage: ${args.discoveryNotes.length > 0 ? args.discoveryNotes.join("; ") : "user-provided URLs and links discovered from them"}.`,
    "OmniResearch crawled only permitted, public pages from the configured discovery sources. It did NOT search the entire internet.",
    ...(providerId === "mock"
      ? ["Synthesis used the built-in deterministic mock provider, which assembles findings from source sentences and does not provide real analytical synthesis."]
      : [`Synthesis used ${provider.displayName}.`]),
    ...verificationNotes,
  ].join("\n\n");

  const report = await prisma.report.create({
    data: {
      id: newId("rep"),
      projectId: project.id,
      runId,
      title: `${project.title} — research report`,
      citationStyle: project.citationStyle,
      methodology: limitations,
      limitations: verificationNotes.join(" ") || null,
      providerUsed: providerId,
      verifiedAt: new Date(),
    },
  });

  for (const [index, section] of cleanedSections.entries()) {
    await prisma.reportSection.create({
      data: {
        id: newId("sec"),
        reportId: report.id,
        kind: section.kind,
        title: section.title.slice(0, 290),
        contentMd: section.contentMd,
        order: index,
      },
    });
  }

  for (const marker of [...usedMarkers].sort((a, b) => a - b)) {
    const entry = verifiedMarkers.get(marker)!;
    await prisma.citation.create({
      data: {
        id: newId("cit"),
        reportId: report.id,
        sourceId: entry.row.sourceId,
        evidenceId: entry.row.id,
        marker,
        quotedText: entry.row.evidenceText.slice(0, 1000),
        locator: entry.row.sourceLocation,
        pageNumber: entry.row.pageNumber,
        verified: true,
        verifyNote: entry.verifyNote,
      },
    });
    counters.citations++;
  }

  // Record failed verifications on the run log for transparency.
  for (const [marker, entry] of verifiedMarkers) {
    if (!entry.verified && markerMap.has(marker)) {
      await prisma.runEvent.create({
        data: {
          id: newId("ev"),
          runId,
          stage: "verifying-citations",
          message: `Citation [${marker}] failed verification: ${entry.verifyNote}`,
        },
      });
    }
  }

  await deps.emit("verifying-citations", `Verified ${counters.citations} citation(s)`, counters);
  return report.id;
}
