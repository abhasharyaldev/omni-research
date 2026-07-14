import { detectBillingSensitiveVars } from "@omni/security";
import type {
  GenerateStructuredRequest,
  GenerateTextRequest,
  GenerateTextResult,
  ProviderAuthenticationStatus,
  ProviderCapabilities,
  ProviderInstallationStatus,
  StructuredSchema,
  SubscriptionAIProvider,
} from "../provider-types.js";
import { ProviderError } from "../provider-types.js";
import { buildPrompt, parseStructured } from "../structured-output.js";

/**
 * OpenAI-compatible HTTP provider: one adapter covers LM Studio, llama.cpp
 * server, vLLM, text-generation-webui, and any other server that speaks the
 * `/v1/chat/completions` protocol.
 *
 * Explicit configuration only (OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_MODEL).
 * Loopback endpoints are treated as local; a REMOTE endpoint additionally
 * requires OPENAI_COMPAT_ALLOW_REMOTE=1 so data never leaves the device
 * without an explicit opt-in. The optional API key stays server-side.
 */
export class OpenAiCompatProvider implements SubscriptionAIProvider {
  id = "openai-compatible" as const;
  displayName = "OpenAI-compatible server (LM Studio / llama.cpp / vLLM)";

  private base(): string | null {
    const raw = process.env.OPENAI_COMPAT_BASE_URL?.trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin + url.pathname.replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  private isLoopback(): boolean {
    const base = this.base();
    if (!base) return false;
    const host = new URL(base).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  }

  private model(): string {
    return process.env.OPENAI_COMPAT_MODEL?.trim() || "local-model";
  }

  private remoteBlockedReason(): string | null {
    const base = this.base();
    if (!base) return "OPENAI_COMPAT_BASE_URL is not configured";
    if (!this.isLoopback() && process.env.OPENAI_COMPAT_ALLOW_REMOTE !== "1") {
      return `Endpoint ${new URL(base).host} is not loopback; set OPENAI_COMPAT_ALLOW_REMOTE=1 to explicitly allow sending text to a remote server`;
    }
    return null;
  }

  async checkInstallation(): Promise<ProviderInstallationStatus> {
    const base = this.base();
    if (!base) {
      return { installed: false, detail: "Set OPENAI_COMPAT_BASE_URL (e.g. http://127.0.0.1:1234 for LM Studio, http://127.0.0.1:8080 for llama.cpp server)" };
    }
    const blocked = this.remoteBlockedReason();
    if (blocked) return { installed: false, detail: blocked };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(`${base}/v1/models`, { headers: this.headers(), signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return { installed: false, detail: `${base}/v1/models returned ${response.status}` };
      const data = (await response.json()) as { data?: { id: string }[] };
      const models = (data.data ?? []).map((m) => m.id);
      return {
        installed: true,
        version: models.length > 0 ? `models: ${models.slice(0, 3).join(", ")}${models.length > 3 ? "…" : ""}` : "server reachable",
        detail: `${this.isLoopback() ? "local" : "REMOTE"} endpoint ${base}`,
      };
    } catch (err) {
      return { installed: false, detail: `Cannot reach ${base}: ${(err as Error).message.slice(0, 120)}` };
    }
  }

  async checkAuthentication(): Promise<ProviderAuthenticationStatus> {
    return {
      authenticated: true,
      method: "local",
      detail: this.isLoopback()
        ? "Local endpoint — prompts never leave this machine"
        : "Remote endpoint explicitly allowed via OPENAI_COMPAT_ALLOW_REMOTE=1 — prompts are sent to that server",
      billingWarnings: detectBillingSensitiveVars().map((v) => `${v} is set in your environment; it is never forwarded`),
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      textGeneration: true,
      structuredOutput: "prompted",
      streaming: false,
      localOnly: this.isLoopback(),
      imageInput: false, // conservative: chat-completions vision support varies by model; never assumed
      translation: true,
      maxInputChars: Number(process.env.OPENAI_COMPAT_MAX_INPUT_CHARS || 60_000),
      notes: [
        "Works with any OpenAI-compatible /v1/chat/completions server (LM Studio, llama.cpp, vLLM, …).",
        "Structured output is prompted JSON validated against the task schema.",
        this.isLoopback() ? "Configured endpoint is loopback (local)." : "Configured endpoint is remote (explicitly allowed).",
      ],
    };
  }

  async cancel(): Promise<void> {
    /* per-request AbortController; no persistent process */
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = process.env.OPENAI_COMPAT_API_KEY;
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  private async chat(prompt: string, requestId: string): Promise<string> {
    const base = this.base();
    const blocked = this.remoteBlockedReason();
    if (!base || blocked) throw new ProviderError("not-installed", blocked ?? "OPENAI_COMPAT_BASE_URL is not configured", this.id);
    const maxChars = Number(process.env.OPENAI_COMPAT_MAX_INPUT_CHARS || 60_000);
    if (prompt.length > maxChars) {
      throw new ProviderError("invalid-output", `Input exceeds the configured ${maxChars}-character limit for this provider`, this.id);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.OPENAI_COMPAT_TIMEOUT_MS || 180_000));
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model(),
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          stream: false,
        }),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        throw new ProviderError("unavailable", `Server returned ${response.status}: ${body}`, this.id);
      }
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new ProviderError("invalid-output", "Response exceeded the 2 MB limit", this.id);
      const data = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new ProviderError("invalid-output", `Empty completion from ${this.model()} (request ${requestId})`, this.id);
      }
      return text;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error).name === "AbortError") throw new ProviderError("unavailable", "Request timed out", this.id);
      throw new ProviderError("unavailable", (err as Error).message.slice(0, 300), this.id);
    } finally {
      clearTimeout(timer);
    }
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const prompt = buildPrompt({ instructions: request.instructions, data: request.data, schemaDescription: undefined });
    const text = await this.chat(prompt, request.requestId);
    return { text, provider: this.id, model: this.model(), durationMs: Date.now() - started };
  }

  async generateStructured<T>(request: GenerateStructuredRequest, schema: StructuredSchema<T>): Promise<T> {
    const prompt = buildPrompt({
      instructions: request.instructions,
      data: request.data,
      schemaDescription: request.schemaDescription,
    });
    const text = await this.chat(prompt, request.requestId);
    const parsed = parseStructured(text, schema as never);
    if (!parsed.ok) {
      throw new ProviderError("invalid-output", `Output failed schema validation for "${request.taskKind}": ${parsed.error}`, this.id);
    }
    return parsed.value as T;
  }
}
