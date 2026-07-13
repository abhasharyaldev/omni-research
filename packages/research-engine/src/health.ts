import type { PrismaClient } from "@omni/database";

/**
 * Deterministic research confidence & coverage scoring. No AI involvement —
 * every number is computed from persisted rows so it is reproducible and
 * auditable. Stored on Report.healthJson and recomputable on demand.
 */

export type SubquestionCoverage = {
  subquestionId: string;
  text: string;
  evidenceCount: number;
  strongCount: number;
  supportingCount: number;
  opposingCount: number;
  strongestSource?: { title: string; qualityScore: number; classification: string; sourceId: string };
  weakestGap: string;
  confidence: "high" | "medium" | "low";
};

export type ResearchHealth = {
  computedAt: string;
  runId?: string;
  sourceCount: number;
  distinctDomains: number;
  distinctClassifications: number;
  avgSourceQuality: number;
  primaryOfficialCount: number;
  citationCount: number;
  citationsVerified: boolean;
  evidenceCount: number;
  weakEvidenceCount: number;
  disagreementCount: number;
  unresolvedDisagreementCount: number;
  weakClaimCount: number; // unsupported / weakly-supported / unable-to-verify claims
  coverage: SubquestionCoverage[];
  coveredSubquestions: number;
  totalSubquestions: number;
  overall: "high" | "medium" | "low";
  reasons: string[];
};

const PRIMARY_CLASSES = new Set(["primary-source", "government", "peer-reviewed"]);
const WEAK_STATUSES = new Set(["unsupported", "weakly-supported", "unable-to-verify"]);

export type HealthInputs = {
  sources: { domain: string; classification: string; qualityScore: number; duplicateOfId: string | null }[];
  evidence: { subquestionId: string | null; evidenceStrength: string }[];
  subquestions: { id: string; text: string }[];
  claims: { verificationStatus: string | null; statusExplanation: string | null }[];
  claimStancesBySubquestion: Map<string, { supports: number; opposes: number }>;
  strongestBySubquestion: Map<string, { title: string; qualityScore: number; classification: string; sourceId: string }>;
  citationCount: number;
  citationsVerified: boolean;
  runId?: string;
};

/** Pure scoring — unit-testable without a database. */
export function scoreHealth(input: HealthInputs): ResearchHealth {
  const uniqueSources = input.sources.filter((s) => !s.duplicateOfId);
  const domains = new Set(uniqueSources.map((s) => s.domain));
  const classifications = new Set(uniqueSources.map((s) => s.classification));
  const avgQuality =
    uniqueSources.length > 0
      ? Math.round(uniqueSources.reduce((n, s) => n + s.qualityScore, 0) / uniqueSources.length)
      : 0;
  const primaryCount = uniqueSources.filter((s) => PRIMARY_CLASSES.has(s.classification)).length;

  const disagreements = input.claims.filter((c) => c.verificationStatus === "disputed");
  const unresolved = disagreements.filter((c) => (c.statusExplanation ?? "").toLowerCase().includes("unresolved"));
  const weakClaims = input.claims.filter((c) => c.verificationStatus && WEAK_STATUSES.has(c.verificationStatus));
  const weakEvidence = input.evidence.filter((e) => e.evidenceStrength === "weak").length;

  const coverage: SubquestionCoverage[] = input.subquestions.map((sq) => {
    const rows = input.evidence.filter((e) => e.subquestionId === sq.id);
    const strong = rows.filter((e) => e.evidenceStrength === "strong").length;
    const stances = input.claimStancesBySubquestion.get(sq.id) ?? { supports: 0, opposes: 0 };
    const confidence: SubquestionCoverage["confidence"] =
      rows.length >= 3 && strong >= 1 ? "high" : rows.length >= 2 ? "medium" : "low";
    return {
      subquestionId: sq.id,
      text: sq.text,
      evidenceCount: rows.length,
      strongCount: strong,
      supportingCount: stances.supports,
      opposingCount: stances.opposes,
      strongestSource: input.strongestBySubquestion.get(sq.id),
      weakestGap:
        rows.length === 0
          ? "no evidence at all"
          : strong === 0
            ? "no strong evidence"
            : stances.opposes > 0
              ? "opposing evidence exists"
              : "none identified",
      confidence,
    };
  });
  const covered = coverage.filter((c) => c.evidenceCount >= 2).length;

  // Overall confidence: deterministic thresholds, reasons recorded.
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points >= 0 ? "+" : ""}${points}: ${reason}`);
  };
  add(input.citationsVerified ? 2 : -3, input.citationsVerified ? "all report citations verified against stored sources" : "citations not verified");
  add(coverage.length > 0 && covered === coverage.length ? 2 : covered >= coverage.length / 2 ? 1 : -1,
    `${covered}/${coverage.length} subquestions have ≥2 evidence records`);
  add(domains.size >= 3 ? 1 : domains.size <= 1 ? -1 : 0, `${domains.size} distinct source domain(s)`);
  add(avgQuality >= 65 ? 1 : avgQuality < 45 ? -1 : 0, `average source quality ${avgQuality}/100`);
  add(primaryCount > 0 ? 1 : 0, `${primaryCount} primary/official source(s)`);
  add(unresolved.length > 0 ? -1 : 0, `${unresolved.length} unresolved disagreement(s)`);
  add(weakClaims.length > 0 ? -1 : 0, `${weakClaims.length} weak/unsupported claim(s)`);

  // Unverified citations hard-cap confidence at "low" — verification is the
  // core guarantee and no other metric can compensate for losing it.
  const overall: ResearchHealth["overall"] = !input.citationsVerified
    ? "low"
    : score >= 6
      ? "high"
      : score >= 3
        ? "medium"
        : "low";

  return {
    computedAt: new Date().toISOString(),
    runId: input.runId,
    sourceCount: uniqueSources.length,
    distinctDomains: domains.size,
    distinctClassifications: classifications.size,
    avgSourceQuality: avgQuality,
    primaryOfficialCount: primaryCount,
    citationCount: input.citationCount,
    citationsVerified: input.citationsVerified,
    evidenceCount: input.evidence.length,
    weakEvidenceCount: weakEvidence,
    disagreementCount: disagreements.length,
    unresolvedDisagreementCount: unresolved.length,
    weakClaimCount: weakClaims.length,
    coverage,
    coveredSubquestions: covered,
    totalSubquestions: coverage.length,
    overall,
    reasons,
  };
}

/** Gather inputs from the database for a project (latest completed run). */
export async function computeResearchHealth(prisma: PrismaClient, projectId: string, runId?: string): Promise<ResearchHealth> {
  const run = await prisma.researchRun.findFirst({
    where: runId ? { id: runId } : { projectId, status: "completed" },
    orderBy: { createdAt: "desc" },
    include: { subquestions: { orderBy: { order: "asc" } } },
  });
  const sources = await prisma.source.findMany({
    where: { projectId, status: "retrieved" },
    select: { id: true, finalUrl: true, url: true, classification: true, qualityScore: true, duplicateOfId: true, title: true },
  });
  const evidence = await prisma.evidence.findMany({
    where: { projectId, ...(run ? { runId: run.id } : {}) },
    select: { id: true, subquestionId: true, evidenceStrength: true, sourceId: true },
  });
  const claims = await prisma.claim.findMany({
    where: { projectId },
    include: { evidence: { include: { evidence: { select: { subquestionId: true } } } } },
  });
  const report = await prisma.report.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { citations: true } } },
  });

  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const strongestBySubquestion = new Map<string, { title: string; qualityScore: number; classification: string; sourceId: string }>();
  for (const row of evidence) {
    if (!row.subquestionId) continue;
    const source = sourceById.get(row.sourceId);
    if (!source) continue;
    const current = strongestBySubquestion.get(row.subquestionId);
    if (!current || source.qualityScore > current.qualityScore) {
      strongestBySubquestion.set(row.subquestionId, {
        title: source.title ?? source.finalUrl ?? source.url,
        qualityScore: source.qualityScore,
        classification: source.classification,
        sourceId: source.id,
      });
    }
  }
  const stances = new Map<string, { supports: number; opposes: number }>();
  for (const claim of claims) {
    for (const link of claim.evidence) {
      const sq = link.evidence.subquestionId;
      if (!sq) continue;
      const entry = stances.get(sq) ?? { supports: 0, opposes: 0 };
      if (link.stance === "opposes") entry.opposes++;
      else if (link.stance === "supports") entry.supports++;
      stances.set(sq, entry);
    }
  }

  const domainOf = (url: string | null) => {
    try {
      return new URL(url ?? "").hostname.replace(/^www\./, "");
    } catch {
      return "unknown";
    }
  };

  return scoreHealth({
    sources: sources.map((s) => ({
      domain: domainOf(s.finalUrl ?? s.url),
      classification: s.classification,
      qualityScore: s.qualityScore,
      duplicateOfId: s.duplicateOfId,
    })),
    evidence,
    subquestions: (run?.subquestions ?? []).map((s) => ({ id: s.id, text: s.text })),
    claims: claims.map((c) => ({ verificationStatus: c.verificationStatus, statusExplanation: c.statusExplanation })),
    claimStancesBySubquestion: stances,
    strongestBySubquestion,
    citationCount: report?._count.citations ?? 0,
    citationsVerified: Boolean(report?.verifiedAt),
    runId: run?.id,
  });
}
