import { DATA_ONLY_PREAMBLE } from "@omni/security";
import { buildPrompt, parseStructured } from "../structured-output.js";
import {
  ProviderError,
  type GenerateStructuredRequest,
  type GenerateTextRequest,
  type GenerateTextResult,
  type ProviderAuthenticationStatus,
  type ProviderCapabilities,
  type ProviderInstallationStatus,
  type StructuredSchema,
  type SubscriptionAIProvider,
} from "../provider-types.js";

/**
 * Ollama adapter: fully local models over the local HTTP API. No cloud key,
 * no account. Only 127.0.0.1/localhost base URLs are accepted — this adapter
 * is a local bridge, never a remote proxy.
 */
export class OllamaProvider implements SubscriptionAIProvider {
  id = "ollama" as const;
  displayName = "Ollama (local models)";

  private controllers = new Map<string, AbortController>();

  private baseUrl(): string {
    const url = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new ProviderError(
        "disallowed-operation",
        `OLLAMA_BASE_URL must point at the local machine (got ${host}). Remote Ollama endpoints are not supported.`,
        this.id
      );
    }
    return url.replace(/\/$/, "");
  }

  private model(): string {
    return process.env.OLLAMA_MODEL || "llama3.1";
  }

  async checkInstallation(): Promise<ProviderInstallationStatus> {
    try {
      const response = await fetch(`${this.baseUrl()}/api/version`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return { installed: false, detail: `Ollama server responded HTTP ${response.status}` };
      }
      const data = (await response.json()) as { version?: string };
      return { installed: true, version: data.version, path: this.baseUrl() };
    } catch (err) {
      return {
        installed: false,
        detail: `No Ollama server at ${process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"} (${(err as Error).message}). Install from https://ollama.com and run \`ollama serve\`.`,
      };
    }
  }

  async checkAuthentication(): Promise<ProviderAuthenticationStatus> {
    const installed = await this.checkInstallation();
    if (!installed.installed) {
      return { authenticated: false, method: "local", detail: installed.detail, billingWarnings: [] };
    }
    // Verify the configured model is actually pulled.
    try {
      const response = await fetch(`${this.baseUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const data = (await response.json()) as { models?: { name: string }[] };
      const wanted = this.model();
      const found = data.models?.some((m) => m.name === wanted || m.name.startsWith(`${wanted}:`));
      if (!found) {
        return {
          authenticated: false,
          method: "local",
          detail: `Model "${wanted}" is not downloaded. Run: ollama pull ${wanted}`,
          billingWarnings: [],
        };
      }
      return { authenticated: true, method: "local", detail: `Model "${wanted}" is available locally`, billingWarnings: [] };
    } catch (err) {
      return { authenticated: false, method: "local", detail: (err as Error).message, billingWarnings: [] };
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      textGeneration: true,
      structuredOutput: "native",
      streaming: false,
      localOnly: true,
      notes: [
        "Runs entirely on this machine; no cloud API key.",
        "Uses /api/generate with format=json for structured tasks.",
        "Context-window limits depend on the pulled model.",
      ],
    };
  }

  async cancel(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
    this.controllers.delete(requestId);
  }

  private async generate(request: GenerateTextRequest, json: boolean): Promise<string> {
    const controller = new AbortController();
    this.controllers.set(request.requestId, controller);
    const timeoutMs = Number(process.env.AI_PROCESS_TIMEOUT_MS || 180_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const prompt = buildPrompt({
        instructions: request.instructions,
        data: request.data,
        dataPreamble: request.data ? DATA_ONLY_PREAMBLE(request.data.match(/<<<SOURCE ([a-f0-9]{24})/)?.[1] ?? "unfenced") : undefined,
      });
      const maxInput = Number(process.env.AI_MAX_INPUT_CHARACTERS || 200_000);
      if (prompt.length > maxInput) {
        throw new ProviderError("input-too-large", `Prompt of ${prompt.length} chars exceeds limit ${maxInput}`, this.id);
      }
      const response = await fetch(`${this.baseUrl()}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model(),
          prompt,
          stream: false,
          ...(json ? { format: "json" } : {}),
        }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        throw new ProviderError("unavailable", `Model "${this.model()}" not found. Run: ollama pull ${this.model()}`, this.id);
      }
      if (!response.ok) {
        throw new ProviderError("unavailable", `Ollama responded HTTP ${response.status}`, this.id);
      }
      const data = (await response.json()) as { response?: string };
      const text = (data.response ?? "").trim();
      if (!text) throw new ProviderError("invalid-output", "Ollama returned an empty response", this.id);
      const maxOutput = Number(process.env.AI_MAX_OUTPUT_CHARACTERS || 200_000);
      return text.slice(0, maxOutput);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error).name === "AbortError" || (err as any).name === "TimeoutError") {
        throw new ProviderError("timeout", "Ollama request aborted or timed out", this.id);
      }
      throw new ProviderError("unavailable", `Ollama request failed: ${(err as Error).message}`, this.id);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(request.requestId);
    }
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const text = await this.generate(request, false);
    return { text, provider: this.id, model: this.model(), durationMs: Date.now() - started };
  }

  async generateStructured<T>(request: GenerateStructuredRequest, schema: StructuredSchema<T>): Promise<T> {
    const text = await this.generate(
      {
        ...request,
        instructions: `${request.instructions}\n\nOUTPUT FORMAT:\nRespond with ONLY one JSON payload matching:\n${request.schemaDescription}`,
      },
      true
    );
    const parsed = parseStructured(text, schema);
    if (!parsed.ok) {
      throw new ProviderError("invalid-output", `Structured output invalid: ${parsed.error}`, this.id);
    }
    return parsed.value;
  }
}
