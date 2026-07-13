import type { ResearchPackage } from "./research-package.js";
import type { StoryHooks, StoryScript } from "./schemas.js";

/**
 * Deterministic, provider-independent script validation. The storytelling
 * layer can propose anything; nothing is marked ready while high-risk
 * problems remain. All checks run against the research package — the same
 * evidence the reader can open from the editor.
 */

export type LineStatus = "supported" | "inferred" | "disputed" | "opinion" | "unsupported" | "non-factual";

export type ValidationIssue = {
  code:
    | "unsupported-claim"
    | "unknown-evidence-ref"
    | "missing-citation"
    | "altered-number"
    | "unsupported-year"
    | "invented-quote"
    | "exaggerated-language"
    | "disputed-stated-as-fact"
    | "locked-fact-missing"
    | "misleading-title";
  severity: "high" | "medium" | "low";
  lineIndex?: number;
  text: string;
  detail: string;
};

export type ScriptValidation = {
  lineStatuses: { lineIndex: number; status: LineStatus; evidenceRefs: string[] }[];
  issues: ValidationIssue[];
  supportedLines: number;
  factLines: number;
  verdict: "ready" | "needs-review";
  summary: string;
};

const EXAGGERATION = /\b(shocking(ly)?|unbelievable|insane|mind-?blowing|never before|biggest ever|first ever|only one in the world|secret(ly)? hidden|they don'?t want you to know|guaranteed|100% proven|everyone is talking about)\b/i;
const NEEDS_SUPPORT_SUPERLATIVES = /\b(biggest|largest|smallest|first|only|fastest|oldest|newest|most \w+)\b/i;

const normalize = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, '"').replace(/\s+/g, " ").trim();

function numbersIn(text: string): string[] {
  // Numbers with 2+ digits or decimals/percent (single digits are too noisy).
  return [...text.matchAll(/\b\d{2,}(?:[.,]\d+)?%?\b/g)].map((m) => m[0].replace(/,/g, ""));
}

export function validateScript(
  pkg: ResearchPackage,
  script: StoryScript,
  lockedFacts: { evidenceRef: string; text: string }[] = []
): ScriptValidation {
  const byRef = new Map(pkg.evidence.map((e) => [e.ref, e]));
  const allEvidenceText = normalize(pkg.evidence.map((e) => `${e.claim} ${e.excerpt}`).join(" \n "));
  const disputedText = normalize(pkg.disputedClaims.map((d) => d.text).join(" \n "));
  const issues: ValidationIssue[] = [];
  const lineStatuses: ScriptValidation["lineStatuses"] = [];
  let factLines = 0;
  let supportedLines = 0;

  script.lines.forEach((line, lineIndex) => {
    const refs = line.evidenceRefs ?? [];
    const validRefs = refs.filter((r) => byRef.has(r));
    for (const ref of refs) {
      if (!byRef.has(ref)) {
        issues.push({
          code: "unknown-evidence-ref",
          severity: "high",
          lineIndex,
          text: line.text,
          detail: `Reference "${ref}" does not exist in research package v${pkg.packageVersion} — citations must never be invented.`,
        });
      }
    }

    const supportText = normalize(validRefs.map((r) => `${byRef.get(r)!.claim} ${byRef.get(r)!.excerpt}`).join(" \n "));
    const lineNorm = normalize(line.text);
    let status: LineStatus = "non-factual";

    if (line.statement === "fact" || line.statement === "reported-claim") {
      factLines++;
      if (validRefs.length === 0) {
        status = "unsupported";
        issues.push({
          code: "missing-citation",
          severity: "high",
          lineIndex,
          text: line.text,
          detail: `Line is labeled "${line.statement}" but carries no valid evidence reference.`,
        });
      } else {
        status = "supported";
        supportedLines++;
      }
      // Disputed content stated as plain fact.
      if (disputedText && lineNorm.length > 20) {
        const lineTokens = new Set(lineNorm.split(" ").filter((t) => t.length > 4));
        const disputedTokens = disputedText.split(" ").filter((t) => t.length > 4);
        const overlap = disputedTokens.filter((t) => lineTokens.has(t)).length;
        if (overlap >= 4 && line.statement === "fact") {
          status = "disputed";
          issues.push({
            code: "disputed-stated-as-fact",
            severity: "high",
            lineIndex,
            text: line.text,
            detail: "This overlaps a claim the research marked DISPUTED; present both sides or label the uncertainty.",
          });
        }
      }
      // Numbers must exist in the cited evidence (altered-number check).
      for (const num of numbersIn(line.text)) {
        const target = supportText || allEvidenceText;
        if (!target.includes(num.toLowerCase())) {
          issues.push({
            code: "altered-number",
            severity: "high",
            lineIndex,
            text: line.text,
            detail: `The number "${num}" does not appear in the cited evidence — numbers must be copied, never rounded for drama.`,
          });
        }
      }
      // Years must appear in evidence text or evidence dates.
      for (const year of line.text.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) ?? []) {
        const inDates = pkg.evidence.some((e) => (e.publishedAt ?? "").startsWith(year) || (e.eventDate ?? "").startsWith(year));
        if (!allEvidenceText.includes(year) && !inDates) {
          issues.push({
            code: "unsupported-year",
            severity: "medium",
            lineIndex,
            text: line.text,
            detail: `The year ${year} appears in no evidence text or evidence date.`,
          });
        }
      }
    } else if (line.statement === "inference" || line.statement === "interpretation") {
      status = "inferred";
    } else if (line.statement === "opinion") {
      status = "opinion";
    } else if (line.statement === "speculation" || line.statement === "unknown") {
      status = "inferred";
    }

    // Invented quotations: quoted spans (5+ words) must be verbatim in evidence.
    for (const match of line.text.matchAll(/[""]([^""]{20,300})[""]/g)) {
      const quoted = normalize(match[1]!);
      if (quoted.split(" ").length >= 5 && !allEvidenceText.includes(quoted)) {
        issues.push({
          code: "invented-quote",
          severity: "high",
          lineIndex,
          text: line.text,
          detail: "Quotation marks promise verbatim words, but this quote is not found in any evidence excerpt.",
        });
      }
    }

    // Exaggeration lexicon.
    if (EXAGGERATION.test(line.text)) {
      issues.push({
        code: "exaggerated-language",
        severity: "medium",
        lineIndex,
        text: line.text,
        detail: "Sensational phrasing detected; rewrite with the evidence's own scale.",
      });
    } else if (NEEDS_SUPPORT_SUPERLATIVES.test(line.text) && (line.statement === "fact" || line.statement === "reported-claim")) {
      const superlative = line.text.match(NEEDS_SUPPORT_SUPERLATIVES)![0];
      const target = supportText || allEvidenceText;
      if (!target.includes(superlative.toLowerCase())) {
        issues.push({
          code: "exaggerated-language",
          severity: "medium",
          lineIndex,
          text: line.text,
          detail: `Superlative "${superlative}" is not present in the cited evidence.`,
        });
      }
    }

    lineStatuses.push({ lineIndex, status, evidenceRefs: validRefs });
  });

  // Locked facts must survive rewrites: their evidence must still be cited
  // somewhere, and their text must still appear (fuzzy) in the script.
  const scriptNorm = normalize(script.lines.map((l) => l.text).join(" \n "));
  const citedRefs = new Set(script.lines.flatMap((l) => l.evidenceRefs ?? []));
  for (const locked of lockedFacts) {
    const textPresent = scriptNorm.includes(normalize(locked.text).slice(0, 60));
    if (!citedRefs.has(locked.evidenceRef) && !textPresent) {
      issues.push({
        code: "locked-fact-missing",
        severity: "high",
        text: locked.text,
        detail: `Locked fact (${locked.evidenceRef}) was dropped by a rewrite — locked facts must not be silently removed.`,
      });
    }
  }

  // Title honesty: exaggerated titles are flagged.
  if (EXAGGERATION.test(script.title)) {
    issues.push({
      code: "misleading-title",
      severity: "medium",
      text: script.title,
      detail: "Title uses sensational phrasing not supported by the evidence.",
    });
  }

  const high = issues.filter((i) => i.severity === "high").length;
  const verdict: ScriptValidation["verdict"] = high === 0 ? "ready" : "needs-review";
  return {
    lineStatuses,
    issues,
    supportedLines,
    factLines,
    verdict,
    summary:
      `${supportedLines}/${factLines} factual lines carry valid evidence references; ` +
      `${issues.length} issue(s) (${high} high-risk). ` +
      (verdict === "ready"
        ? "No high-risk problems — script may be marked verified."
        : "High-risk problems present — the script cannot be marked verified until they are resolved."),
  };
}

/** Hook safety gate (deterministic, in addition to provider self-labeling). */
export function vetHooks(pkg: ResearchPackage, hooks: StoryHooks): { accepted: StoryHooks["hooks"]; rejected: { hook: StoryHooks["hooks"][number]; reason: string }[] } {
  const byRef = new Map(pkg.evidence.map((e) => [e.ref, e]));
  const accepted: StoryHooks["hooks"] = [];
  const rejected: { hook: StoryHooks["hooks"][number]; reason: string }[] = [];
  for (const hook of hooks.hooks) {
    const validRefs = (hook.evidenceRefs ?? []).filter((r) => byRef.has(r));
    if (validRefs.length === 0) {
      rejected.push({ hook, reason: "No valid evidence reference — hooks must rest on a real claim from the package." });
      continue;
    }
    if (EXAGGERATION.test(hook.text)) {
      rejected.push({ hook, reason: "Sensational phrasing (fake urgency / unsupported superlative)." });
      continue;
    }
    if (hook.exaggerationRisk === "high" && !hook.saferAlternative) {
      rejected.push({ hook, reason: "Self-rated high exaggeration risk without a safer alternative." });
      continue;
    }
    accepted.push(hook);
  }
  return { accepted, rejected };
}
