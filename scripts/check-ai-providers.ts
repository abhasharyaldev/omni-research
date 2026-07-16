/**
 * Detect installed AI providers and print a readiness summary.
 * Non-destructive: no generation requests are sent (so no plan usage is
 * consumed). Use `pnpm test:provider:<name>` for a live smoke test.
 *
 * Usage: pnpm check:providers
 */
import { loadRootEnv } from "@omni/shared/env";
import { getProviderManager } from "@omni/ai-providers";
import { detectBillingSensitiveVars } from "@omni/security";

async function main(): Promise<void> {
  loadRootEnv();
  console.log("OmniResearch — AI provider readiness\n");
  const manager = getProviderManager();
  const reports = await manager.statusAll();

  for (const report of reports) {
    const icon = report.statusCode === "ready" ? "✓" : report.statusCode === "not-installed" ? "·" : "!";
    console.log(`${icon} ${report.displayName.padEnd(24)} ${report.statusCode}`);
    if (report.installation.version) console.log(`    version: ${report.installation.version}`);
    if (report.installation.detail) console.log(`    ${report.installation.detail}`);
    if (report.authentication.detail) console.log(`    ${report.authentication.detail}`);
    for (const warning of report.authentication.billingWarnings) {
      console.log(`    ⚠ ${warning}`);
    }
  }

  const billing = detectBillingSensitiveVars();
  console.log(`\nDefault provider: ${manager.defaultId()}`);
  console.log(`Paid API keys required: No`);
  if (billing.length > 0) {
    console.log(`⚠ Billing-sensitive variables present (never forwarded): ${billing.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("check failed:", err.message);
  process.exit(1);
});
