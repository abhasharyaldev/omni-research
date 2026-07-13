import { CliProviderBase } from "./cli-base.js";

/**
 * Gemini CLI adapter (Google-account authentication).
 *
 * Uses non-interactive mode with the prompt piped via stdin. Tool use is not
 * enabled (no --yolo / auto-approval flags are ever passed).
 */
export class GeminiCliProvider extends CliProviderBase {
  id = "gemini-cli" as const;
  displayName = "Gemini CLI";

  protected executable(): string {
    return process.env.GEMINI_CLI_PATH || "gemini";
  }

  protected generationArgs(): string[] {
    // Reading the prompt from stdin is the documented non-interactive mode.
    return [];
  }

  protected async authHeuristic(): Promise<{ authenticated: boolean | "unknown"; detail: string }> {
    if (this.fileExists(".gemini", "oauth_creds.json")) {
      return {
        authenticated: "unknown",
        detail:
          "Gemini CLI OAuth credentials found. Use 'Test connection' to confirm (may count against your quota).",
      };
    }
    if (this.fileExists(".gemini", "settings.json")) {
      return {
        authenticated: "unknown",
        detail:
          "Gemini CLI settings found but no OAuth credentials. If you use API-key mode, note that OmniResearch never forwards GEMINI_API_KEY/GOOGLE_API_KEY.",
      };
    }
    return {
      authenticated: false,
      detail: "No Gemini CLI login found. Run `gemini` once and sign in with your Google account.",
    };
  }

  protected billingWarningsFor(): string[] {
    return ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"];
  }

  protected capabilityNotes(): string[] {
    return [
      "Uses the Gemini CLI non-interactive mode with the prompt on stdin.",
      "Google-account (OAuth) authentication; quotas of the free/subscription tier apply and are respected.",
      "GEMINI_API_KEY / GOOGLE_API_KEY are deliberately not forwarded to avoid silent API billing.",
    ];
  }
}
