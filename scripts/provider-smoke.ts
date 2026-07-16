/**
 * Manual provider smoke test (LIVE — may count against subscription usage).
 *
 * Usage:
 *   pnpm test:provider:codex     (= tsx scripts/provider-smoke.ts codex-cli)
 *   pnpm test:provider:claude
 *   pnpm test:provider:gemini
 *   pnpm test:provider:ollama
 */
import { loadRootEnv } from "@omni/shared/env";
import { getProviderManager } from "@omni/ai-providers";
import { PROVIDER_IDS, type ProviderId } from "@omni/shared";

async function main(): Promise<void> {
  loadRootEnv();
  const id = process.argv[2] as ProviderId | undefined;
  if (!id || !PROVIDER_IDS.includes(id)) {
    console.error(`Usage: tsx scripts/provider-smoke.ts <${PROVIDER_IDS.join("|")}>`);
    process.exit(2);
  }
  console.log(`⚠ Live smoke test for "${id}" — this sends one small request and MAY count against your subscription usage/quota.\n`);
  const manager = getProviderManager();
  const status = await manager.status(id);
  console.log(`status: ${status.statusCode}`);
  if (status.statusCode === "not-installed") {
    console.error(status.installation.detail ?? "not installed");
    process.exit(1);
  }
  const result = await manager.testConnection(id);
  console.log(result.ok ? `✓ ${result.detail}` : `❌ ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err.message);
  process.exit(1);
});
