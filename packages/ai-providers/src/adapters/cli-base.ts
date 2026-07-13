import { existsSync } from "node:fs";
import path from "node:path";
import { detectBillingSensitiveVars } from "@omni/security";
import type { ProviderId } from "@omni/shared";
import { getProcessRunner, type ProcessRunner } from "../process-runner.js";
import { buildPrompt, parseStructured } from "../structured-output.js";
import {
  ProviderError,
  classifyCliFailure,
  type GenerateStructuredRequest,
  type GenerateTextRequest,
  type GenerateTextResult,
  type ProviderAuthenticationStatus,
  type ProviderCapabilities,
  type ProviderInstallationStatus,
  type StructuredSchema,
  type SubscriptionAIProvider,
} from "../provider-types.js";
import { DATA_ONLY_PREAMBLE } from "@omni/security";

/**
 * Shared behavior for subscription-authenticated CLI adapters (Codex CLI,
 * Claude Code, Gemini CLI):
 *
 * - The CLI binary is located from its configured path/name; we never guess
 *   authentication state destructively and never touch credentials directly —
 *   login happens in the official tool.
 * - Prompts are passed via stdin (no shell, no interpolation).
 * - Tool use / code execution is disabled via each CLI's supported flags, and
 *   the process runs in an isolated temp workspace with a filtered
 *   environment (API-key variables are never forwarded).
 */
export abstract class CliProviderBase implements SubscriptionAIProvider {
  abstract id: ProviderId;
  abstract displayName: string;

  protected runner: ProcessRunner;

  constructor(runner?: ProcessRunner) {
    this.runner = runner ?? getProcessRunner();
  }

  /** Configured executable (name on PATH or absolute path). */
  protected abstract executable(): string;
  /** Fixed argument template for one-shot text generation. */
  protected abstract generationArgs(): string[];
  /** Fixed argument template for a version probe. */
  protected versionArgs(): string[] {
    return ["--version"];
  }
  /** Parse the CLI's stdout into plain text (adapters override for JSON envelopes). */
  protected parseOutput(stdout: string): string {
    return stdout.trim();
  }
  /** Best-effort, non-destructive authentication heuristic (config file checks). */
  protected abstract authHeuristic(): Promise<{ authenticated: boolean | "unknown"; detail: string }>;
  protected abstract billingWarningsFor(): string[];
  protected abstract capabilityNotes(): string[];

  protected home(): string {
    return process.env.USERPROFILE || process.env.HOME || "";
  }

  protected fileExists(...segments: string[]): boolean {
    const base = this.home();
    if (!base) return false;
    return existsSync(path.join(base, ...segments));
  }

  async checkInstallation(): Promise<ProviderInstallationStatus> {
    const exe = this.executable();
    this.runner.allowExecutable(exe);
    try {
      const result = await this.runner.run({
        requestId: `install-check-${this.id}-${Date.now()}`,
        executable: exe,
        args: this.versionArgs(),
      });
      if (result.exitCode === 0) {
        return {
          installed: true,
          version: result.stdout.trim().split("\n")[0]?.slice(0, 100),
          path: exe,
        };
      }
      return {
        installed: false,
        detail: `"${exe} ${this.versionArgs().join(" ")}" exited with code ${result.exitCode}`,
      };
    } catch (err) {
      return {
        installed: false,
        detail: `Could not launch "${exe}": ${(err as Error).message}. Install the official CLI and/or set its path in .env.`,
      };
    }
  }

  async checkAuthentication(): Promise<ProviderAuthenticationStatus> {
    const installed = await this.checkInstallation();
    const billingWarnings = detectBillingSensitiveVars()
      .filter((v) => this.billingWarningsFor().includes(v))
      .map(
        (v) =>
          `${v} is set in your environment. OmniResearch never forwards it, because it could switch this CLI to pay-as-you-go API billing. Unset it if you want to be certain the CLI itself cannot pick it up when run outside OmniResearch.`
      );
    if (!installed.installed) {
      return { authenticated: false, method: "none", detail: "CLI not installed", billingWarnings };
    }
    const heuristic = await this.authHeuristic();
    return {
      authenticated: heuristic.authenticated,
      method: "subscription-account",
      detail: heuristic.detail,
      billingWarnings,
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      textGeneration: true,
      structuredOutput: "prompted",
      streaming: false,
      localOnly: false,
      notes: this.capabilityNotes(),
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.runner.cancel(requestId);
  }

  protected extraAllowedEnv(): string[] {
    return [];
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const exe = this.executable();
    this.runner.allowExecutable(exe);
    const prompt = buildPrompt({
      instructions: request.instructions,
      data: request.data,
      dataPreamble: request.data ? DATA_ONLY_PREAMBLE(fenceTokenFromData(request.data)) : undefined,
    });
    const started = Date.now();
    let result;
    try {
      result = await this.runner.run({
        requestId: request.requestId,
        executable: exe,
        args: this.generationArgs(),
        stdin: prompt,
        extraAllowedEnv: this.extraAllowedEnv(),
      });
    } catch (err) {
      if ((err as any).code === "input-too-large") {
        throw new ProviderError("input-too-large", (err as Error).message, this.id);
      }
      throw new ProviderError("not-installed", `Could not launch ${exe}: ${(err as Error).message}`, this.id);
    }
    if (result.timedOut) {
      throw new ProviderError("timeout", `${this.displayName} timed out after ${result.durationMs}ms`, this.id);
    }
    if (result.exitCode !== 0) {
      throw classifyCliFailure(this.id, `${result.stderr}\n${result.stdout}`, result.exitCode);
    }
    const text = this.parseOutput(result.stdout);
    if (!text) {
      throw new ProviderError("invalid-output", `${this.displayName} returned empty output`, this.id);
    }
    return { text, provider: this.id, durationMs: Date.now() - started };
  }

  async generateStructured<T>(request: GenerateStructuredRequest, schema: StructuredSchema<T>): Promise<T> {
    const attempt = async (extraNote?: string): Promise<T> => {
      const instructions = extraNote
        ? `${request.instructions}\n\nIMPORTANT: ${extraNote}`
        : request.instructions;
      const { text } = await this.generateText({
        ...request,
        instructions: `${instructions}\n\nOUTPUT FORMAT:\nRespond with ONLY one JSON payload matching:\n${request.schemaDescription}`,
      });
      const parsed = parseStructured(text, schema);
      if (!parsed.ok) {
        throw new ProviderError("invalid-output", `Structured output invalid: ${parsed.error}`, this.id);
      }
      return parsed.value;
    };
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ProviderError && err.code === "invalid-output") {
        // One retry with an explicit reminder; then surface the failure honestly.
        return await attempt(
          "Your previous answer was not valid JSON for the requested schema. Return ONLY the JSON payload, with no prose and no code fences."
        );
      }
      throw err;
    }
  }
}

/** Recover the fence token from an already-fenced data block (first marker line). */
function fenceTokenFromData(data: string): string {
  const match = data.match(/<<<SOURCE ([a-f0-9]{24})/);
  return match?.[1] ?? "unfenced";
}
