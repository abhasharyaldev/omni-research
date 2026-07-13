import type { ProviderId, ProviderStatusCode } from "@omni/shared";
import { MockProvider } from "./adapters/mock-provider.js";
import { OllamaProvider } from "./adapters/ollama-provider.js";
import { ClaudeCodeProvider } from "./adapters/claude-code-provider.js";
import { CodexCliProvider } from "./adapters/codex-cli-provider.js";
import { GeminiCliProvider } from "./adapters/gemini-cli-provider.js";
import type { ProviderStatusReport, SubscriptionAIProvider } from "./provider-types.js";
import { ProviderError } from "./provider-types.js";

export class ProviderManager {
  private providers = new Map<ProviderId, SubscriptionAIProvider>();

  constructor() {
    for (const provider of [
      new CodexCliProvider(),
      new ClaudeCodeProvider(),
      new GeminiCliProvider(),
      new OllamaProvider(),
      new MockProvider(),
    ]) {
      this.providers.set(provider.id, provider);
    }
  }

  list(): SubscriptionAIProvider[] {
    return [...this.providers.values()];
  }

  get(id: ProviderId): SubscriptionAIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError("not-installed", `Unknown provider "${id}"`, "mock");
    }
    return provider;
  }

  /** Default from env/user settings; the mock provider is always a valid fallback. */
  defaultId(): ProviderId {
    const configured = (process.env.AI_PROVIDER ?? "mock") as ProviderId;
    return this.providers.has(configured) ? configured : "mock";
  }

  async status(id: ProviderId): Promise<ProviderStatusReport> {
    const provider = this.get(id);
    const lastCheckedAt = new Date().toISOString();
    try {
      const installation = await provider.checkInstallation();
      const authentication = installation.installed
        ? await provider.checkAuthentication()
        : { authenticated: false as const, billingWarnings: [] };
      const capabilities = installation.installed ? await provider.getCapabilities() : undefined;

      let statusCode: ProviderStatusCode;
      if (!installation.installed) statusCode = "not-installed";
      else if (authentication.authenticated === true) statusCode = "ready";
      else if (authentication.authenticated === "unknown") statusCode = "installed";
      else statusCode = "authentication-required";

      return {
        id,
        displayName: provider.displayName,
        statusCode,
        installation,
        authentication,
        capabilities,
        lastCheckedAt,
      };
    } catch (err) {
      return {
        id,
        displayName: provider.displayName,
        statusCode: "misconfigured",
        installation: { installed: false, detail: (err as Error).message },
        authentication: { authenticated: false, billingWarnings: [] },
        lastCheckedAt,
        error: (err as Error).message,
      };
    }
  }

  async statusAll(): Promise<ProviderStatusReport[]> {
    return Promise.all([...this.providers.keys()].map((id) => this.status(id)));
  }

  /**
   * Live end-to-end test with a tiny prompt. May count against subscription
   * usage — only invoked from the explicit "Test connection" action or the
   * manual smoke-test scripts, never automatically.
   */
  async testConnection(id: ProviderId): Promise<{ ok: boolean; detail: string; durationMs?: number }> {
    const provider = this.get(id);
    try {
      const result = await provider.generateText({
        requestId: `test-${id}-${Date.now()}`,
        taskKind: "generic",
        instructions: 'Reply with exactly the word "ready" and nothing else.',
      });
      const ok = result.text.toLowerCase().includes("ready") || result.text.length > 0;
      return {
        ok,
        detail: ok
          ? `Provider responded in ${result.durationMs}ms`
          : `Provider responded but output was unexpected: ${result.text.slice(0, 80)}`,
        durationMs: result.durationMs,
      };
    } catch (err) {
      const message =
        err instanceof ProviderError ? `${err.code}: ${err.message}` : (err as Error).message;
      return { ok: false, detail: message };
    }
  }
}

let sharedManager: ProviderManager | undefined;
export function getProviderManager(): ProviderManager {
  if (!sharedManager) sharedManager = new ProviderManager();
  return sharedManager;
}
