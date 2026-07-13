/**
 * SM-2-style spaced repetition. Quality: 0 (blackout) .. 5 (perfect).
 */
export type ReviewState = { intervalDays: number; ease: number };

export function nextReview(state: ReviewState, quality: number): ReviewState & { dueInDays: number } {
  const q = Math.max(0, Math.min(5, quality));
  let ease = state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  ease = Math.max(1.3, Math.min(3.0, ease));
  let intervalDays: number;
  if (q < 3) {
    intervalDays = 1; // failed recall: reset
  } else if (state.intervalDays <= 1) {
    intervalDays = 3;
  } else {
    intervalDays = Math.round(state.intervalDays * ease * 10) / 10;
  }
  intervalDays = Math.min(intervalDays, 120);
  return { intervalDays, ease, dueInDays: intervalDays };
}

/** Convert a quiz score fraction (0..1) into an SM-2 quality rating. */
export function qualityFromScore(score: number): number {
  if (score >= 0.95) return 5;
  if (score >= 0.8) return 4;
  if (score >= 0.6) return 3;
  if (score >= 0.4) return 2;
  if (score > 0) return 1;
  return 0;
}

/** Mastery update: exponential moving average of quiz scores. */
export function updateMastery(current: number, score: number, attempts: number): number {
  const weight = attempts <= 1 ? 0.7 : 0.4;
  return Math.max(0, Math.min(1, current * (1 - weight) + score * weight));
}
