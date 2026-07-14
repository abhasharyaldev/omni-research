import type { z } from "zod";
import type { ProviderId, ProviderStatusCode } from "@omni/shared";

export type ProviderInstallationStatus = {
  installed: boolean;
  version?: string;
  path?: string;
  detail?: string;
};

export type ProviderAuthenticationStatus = {
  authenticated: boolean | "unknown";
  method?: "subscription-account" | "local" | "none";
  detail?: string;
  billingWarnings: string[]; // e.g. ANTHROPIC_API_KEY present in the parent environment
};

export type ProviderCapabilities = {
  textGeneration: boolean;
  structuredOutput: "native" | "prompted" | "none";
  streaming: boolean;
  localOnly: boolean;
  /** True only when the adapter can accept image/frame input. Absent = false. */
  imageInput?: boolean;
  /** True when the adapter is suitable for translation tasks. Absent = unknown. */
  translation?: boolean;
  /** Bounded input size the adapter enforces. Absent = adapter-managed. */
  maxInputChars?: number;
  notes: string[];
};

export type ProviderCapabilityNeed = "textGeneration" | "structuredOutput" | "imageInput" | "translation";

/**
 * Capability gate used BEFORE dispatching a task. Missing/undefined
 * capabilities are treated as absent — a provider is never assumed capable.
 * Returns null when satisfied, otherwise a user-facing reason (so callers can
 * offer another provider or a degraded mode instead of silently switching).
 */
export function missingCapability(caps: ProviderCapabilities, need: ProviderCapabilityNeed): string | null {
  switch (need) {
    case "textGeneration":
      return caps.textGeneration ? null : "This provider cannot generate text.";
    case "structuredOutput":
      return caps.structuredOutput === "none" ? "This provider cannot produce structured JSON output." : null;
    case "imageInput":
      return caps.imageInput === true ? null : "This provider/model does not accept image input (text-only). Use transcript-only mode or pick a multimodal provider.";
    case "translation":
      return caps.translation === false ? "This provider is not suitable for translation tasks." : null;
  }
}

/**
 * Task kinds let the deterministic mock provider produce useful outputs from
 * the structured context the engines already supply.
 */
export type AiTaskKind =
  | "research-plan"
  | "evidence-extraction"
  | "synthesis"
  | "section-deepen"
  | "lesson-generation"
  | "skill-plan"
  | "news-summaries"
  | "fact-check"
  | "quiz-feedback"
  | "gap-analysis"
  | "reconciliation"
  | "story-blueprint"
  | "story-outline"
  | "story-hooks"
  | "story-scenes"
  | "story-script"
  | "story-critique"
  | "generic";

export type GenerateTextRequest = {
  requestId: string;
  taskKind: AiTaskKind;
  /** Trusted instructions written by the application. */
  instructions: string;
  /** Untrusted fenced source material (data-only). May be empty. */
  data?: string;
  /** Deterministic context for the mock provider and for prompt assembly. */
  context?: Record<string, unknown>;
  maxOutputChars?: number;
};

export type GenerateTextResult = {
  text: string;
  provider: ProviderId;
  model?: string;
  durationMs: number;
};

export type GenerateStructuredRequest = GenerateTextRequest & {
  /** Human-readable description of the expected JSON shape. */
  schemaDescription: string;
};

/**
 * Zod schema with distinct input/output types, so fields with .default()
 * infer as required in the parsed output.
 */
export type StructuredSchema<T> = z.ZodType<T, z.ZodTypeDef, any>;

export interface SubscriptionAIProvider {
  id: ProviderId;
  displayName: string;
  checkInstallation(): Promise<ProviderInstallationStatus>;
  checkAuthentication(): Promise<ProviderAuthenticationStatus>;
  getCapabilities(): Promise<ProviderCapabilities>;
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  generateStructured<T>(request: GenerateStructuredRequest, schema: StructuredSchema<T>): Promise<T>;
  cancel(requestId: string): Promise<void>;
}

export type ProviderStatusReport = {
  id: ProviderId;
  displayName: string;
  statusCode: ProviderStatusCode;
  installation: ProviderInstallationStatus;
  authentication: ProviderAuthenticationStatus;
  capabilities?: ProviderCapabilities;
  lastCheckedAt: string;
  error?: string;
};

export class ProviderError extends Error {
  constructor(
    public readonly code:
      | "not-installed"
      | "authentication-required"
      | "unsupported-plan"
      | "usage-limit-reached"
      | "unavailable"
      | "invalid-output"
      | "timeout"
      | "cancelled"
      | "disallowed-operation"
      | "input-too-large",
    message: string,
    public readonly providerId: ProviderId
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Map raw CLI output/exit info onto a structured provider error when possible. */
export function classifyCliFailure(
  providerId: ProviderId,
  output: string,
  exitCode: number | null
): ProviderError {
  const text = output.toLowerCase();
  if (/(not logged in|login required|please (log|sign) in|unauthorized|authentication|credential)/.test(text)) {
    return new ProviderError("authentication-required", `CLI reports authentication is required (exit ${exitCode})`, providerId);
  }
  if (/(rate limit|usage limit|quota|too many requests|limit reached|429)/.test(text)) {
    return new ProviderError("usage-limit-reached", `CLI reports a usage/rate limit (exit ${exitCode})`, providerId);
  }
  if (/(plan does not|not available on your plan|upgrade your plan|subscription)/.test(text) && /(not|require)/.test(text)) {
    return new ProviderError("unsupported-plan", `CLI reports the current plan does not support this usage (exit ${exitCode})`, providerId);
  }
  return new ProviderError(
    "unavailable",
    `CLI exited with code ${exitCode}: ${output.slice(0, 400) || "no output"}`,
    providerId
  );
}
