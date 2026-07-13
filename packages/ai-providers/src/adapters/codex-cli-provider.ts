import { CliProviderBase } from "./cli-base.js";

/**
 * OpenAI Codex CLI adapter (ChatGPT account authentication where supported).
 *
 * Uses `codex exec` non-interactive mode with the most restrictive sandbox the
 * CLI offers. Prompt via stdin ("-" reads the prompt from stdin in current
 * releases; if the installed version does not support it, the run fails with
 * a clear error rather than falling back to anything unsafe).
 */
export class CodexCliProvider extends CliProviderBase {
  id = "codex-cli" as const;
  displayName = "OpenAI Codex CLI";

  protected executable(): string {
    return process.env.CODEX_CLI_PATH || "codex";
  }

  protected generationArgs(): string[] {
    return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"];
  }

  protected parseOutput(stdout: string): string {
    // `codex exec` prints progress lines and the final message; some versions
    // support JSONL events. Scan JSONL for agent messages first, else take the
    // trailing text block.
    const lines = stdout.split("\n");
    const messages: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const evt = JSON.parse(trimmed);
        const text =
          evt?.msg?.message ?? evt?.message?.content ?? evt?.text ?? evt?.last_agent_message;
        if (typeof text === "string" && text.trim()) messages.push(text.trim());
      } catch {
        /* not JSON */
      }
    }
    if (messages.length > 0) return messages[messages.length - 1]!;
    return stdout.trim();
  }

  protected async authHeuristic(): Promise<{ authenticated: boolean | "unknown"; detail: string }> {
    if (this.fileExists(".codex", "auth.json")) {
      return {
        authenticated: "unknown",
        detail:
          "Codex CLI auth file found. Use 'Test connection' to confirm your ChatGPT-account login (may count against plan usage).",
      };
    }
    return {
      authenticated: false,
      detail: "No Codex CLI login found. Run `codex login` and sign in with your ChatGPT account.",
    };
  }

  protected billingWarningsFor(): string[] {
    return ["OPENAI_API_KEY"];
  }

  protected capabilityNotes(): string[] {
    return [
      "Uses `codex exec` with --sandbox read-only in an isolated temp directory.",
      "Requires `codex login` with a ChatGPT account; not every plan includes Codex CLI access — unsupported plans surface as a clear error.",
      "OPENAI_API_KEY is deliberately not forwarded to avoid silent API billing.",
    ];
  }
}
