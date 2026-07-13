import { createHash, randomBytes } from "node:crypto";

/** URL-safe unique id (time-prefixed for index locality). */
export function newId(prefix = ""): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(9).toString("base64url");
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} characters removed]`;
}

/** Normalized token-shingle similarity in [0,1], used for near-duplicate detection. */
export function textSimilarity(a: string, b: string, shingleSize = 4): number {
  const shingles = (text: string): Set<string> => {
    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    const set = new Set<string>();
    if (tokens.length < shingleSize) {
      if (tokens.length > 0) set.add(tokens.join(" "));
      return set;
    }
    for (let i = 0; i <= tokens.length - shingleSize; i++) {
      set.add(tokens.slice(i, i + shingleSize).join(" "));
    }
    return set;
  };
  const setA = shingles(a);
  const setB = shingles(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** Parse a date from common metadata formats. Returns undefined instead of guessing. */
export function parseMetaDate(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // "05/01/2026" is ambiguous (DD/MM vs MM/DD) — reject BEFORE Date() guesses US format.
  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(trimmed)) return undefined;
  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) {
    const year = direct.getFullYear();
    if (year >= 1500 && year <= 2200) return direct;
  }
  return undefined;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
