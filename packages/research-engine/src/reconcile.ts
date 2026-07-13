import { textSimilarity } from "@omni/shared";

/**
 * Deterministic disagreement detection between evidence records. This finds
 * CANDIDATE conflicts (same topic, opposing polarity, different sources);
 * the AI provider then explains the exact point of conflict — or the pair is
 * reported as unresolved. Detection never fabricates a resolution.
 */

export type ConflictInput = {
  id: string;
  sourceId: string;
  claim: string;
  evidenceText: string;
  subquestionId?: string;
  sourceTitle: string;
  sourcePublishedAt?: Date | null;
  sourceQuality?: number;
  sourceClassification?: string;
};

export type ConflictPair = {
  a: ConflictInput;
  b: ConflictInput;
  similarity: number;
  signal: "negation-mismatch" | "antonym-pair";
};

const NEGATIONS = /\b(not|no|never|cannot|can't|doesn't|does not|isn't|is not|aren't|are not|won't|will not|fails?|without|lacks?)\b/i;

const ANTONYM_PAIRS: [RegExp, RegExp][] = [
  [/\b(increase[sd]?|rise[sn]?|rising|grow(s|th|ing)?|higher|more)\b/i, /\b(decrease[sd]?|decline[sd]?|falling|fell|shrink(s|ing)?|lower|less|fewer)\b/i],
  [/\b(supports?|confirms?|proves?|effective|beneficial|improves?)\b/i, /\b(refutes?|contradicts?|disproves?|ineffective|harmful|worsens?)\b/i],
  [/\b(safe|safely)\b/i, /\b(unsafe|dangerous|risky)\b/i],
];

function polaritySignal(a: string, b: string): ConflictPair["signal"] | null {
  const aNegated = NEGATIONS.test(a);
  const bNegated = NEGATIONS.test(b);
  if (aNegated !== bNegated) return "negation-mismatch";
  for (const [positive, negative] of ANTONYM_PAIRS) {
    if ((positive.test(a) && negative.test(b)) || (negative.test(a) && positive.test(b))) {
      return "antonym-pair";
    }
  }
  return null;
}

const TOPIC_SIMILARITY_THRESHOLD = 0.22; // 1-token shingles over short claims

/**
 * Find pairs of evidence records from DIFFERENT sources that talk about the
 * same thing but with opposing polarity. Bounded to the strongest pairs.
 */
export function detectConflicts(rows: ConflictInput[], maxPairs = 6): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.sourceId === b.sourceId) continue;
      // Same subquestion strengthens the topical link but is not required.
      const similarity = textSimilarity(a.claim, b.claim, 1);
      const topicMatch =
        similarity >= TOPIC_SIMILARITY_THRESHOLD ||
        (a.subquestionId !== undefined && a.subquestionId === b.subquestionId && similarity >= 0.12);
      if (!topicMatch) continue;
      const signal = polaritySignal(`${a.claim} ${a.evidenceText}`, `${b.claim} ${b.evidenceText}`);
      if (!signal) continue;
      pairs.push({ a, b, similarity, signal });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, maxPairs);
}

/** Count evidence records per subquestion; gaps = subquestions below the floor. */
export function findEvidenceGaps(
  subquestions: { id: string; text: string }[],
  evidence: { subquestionId?: string }[],
  minPerSubquestion = 2
): { subquestionId: string; text: string; evidenceCount: number }[] {
  const counts = new Map<string, number>();
  for (const row of evidence) {
    if (row.subquestionId) counts.set(row.subquestionId, (counts.get(row.subquestionId) ?? 0) + 1);
  }
  return subquestions
    .map((sq) => ({ subquestionId: sq.id, text: sq.text, evidenceCount: counts.get(sq.id) ?? 0 }))
    .filter((gap) => gap.evidenceCount < minPerSubquestion);
}
