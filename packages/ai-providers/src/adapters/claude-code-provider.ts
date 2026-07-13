import { CliProviderBase } from "./cli-base.js";

/**
 * Claude Code adapter (subscription/account authentication).
 *
 * Uses the official non-interactive print mode: `claude -p --output-format json`.
 * - Prompt is passed via stdin.
 * - `--max-turns 1` keeps it a single generation, and tool use is not granted
 *   (print mode cannot approve permission prompts, so tools cannot run).
 * - ANTHROPIC_API_KEY is never forwarded: authentication comes from the
 *   user's own `claude` login (subscription), never silent API billing.
 */
export class ClaudeCodeProvider extends CliProviderBase {
  id = "claude-code" as const;
  displayName = "Claude Code";

  protected executable(): string {
    return process.env.CLAUDE_CLI_PATH || "claude";
  }

  protected generationArgs(): string[] {
    return ["-p", "--output-format", "json", "--max-turns", "1"];
  }

  protected parseOutput(stdout: string): string {
    // --output-format json wraps the answer in a JSON envelope with a
    // `result` field. Fall back to raw text when the envelope changes.
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.result === "string") return parsed.result.trim();
        if (parsed.is_error) return "";
      }
    } catch {
      /* fall through to raw text */
    }
    return stdout.trim();
  }

  protected async authHeuristic(): Promise<{ authenticated: boolean | "unknown"; detail: string }> {
    // Non-destructive: look for the CLI's own config; a real check happens via
    // the explicit "Test connection" action (which may consume plan usage).
    if (this.fileExists(".claude.json") || this.fileExists(".claude", ".credentials.json")) {
      return {
        authenticated: "unknown",
        detail:
          "Claude Code configuration found. Use 'Test connection' to confirm your subscription login (a test request may count against plan usage).",
      };
    }
    return {
      authenticated: false,
      detail: "No Claude Code configuration found. Run `claude` once and log in with your Claude account.",
    };
  }

  protected billingWarningsFor(): string[] {
    return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  }

  protected capabilityNotes(): string[] {
    return [
      "Uses `claude -p` print mode with a single turn; agentic tools are not granted.",
      "Requires a Claude account login in the official CLI. Plan limits apply and are respected.",
      "ANTHROPIC_API_KEY is deliberately not forwarded to avoid silent API billing.",
    ];
  }
}
