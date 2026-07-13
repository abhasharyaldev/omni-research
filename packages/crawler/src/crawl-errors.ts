import { NonRetryableError } from "crawlee";
import type { SkipReason } from "@omni/shared";

/**
 * Thrown from crawl hooks/handlers to record a page as deliberately skipped
 * (with a reason shown in the research log) rather than failed.
 */
export class SkipError extends NonRetryableError {
  constructor(
    public readonly skipReason: SkipReason,
    public readonly detail: string
  ) {
    super(`SKIP[${skipReason}]: ${detail}`);
    this.name = "SkipError";
  }
}

export function asSkip(error: unknown): SkipError | null {
  if (error instanceof SkipError) return error;
  // Errors can be re-wrapped by the crawler; recover from the message marker.
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/SKIP\[([a-z-]+)\]: ([\s\S]*)/);
  if (match) return new SkipError(match[1] as SkipReason, match[2]!.slice(0, 500));
  return null;
}
