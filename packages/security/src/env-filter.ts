/**
 * Environment filtering for AI provider child processes.
 *
 * Child processes get a minimal allowlisted environment. API-key variables are
 * NEVER forwarded automatically — forwarding one could silently switch a
 * subscription-authenticated CLI to pay-as-you-go API billing.
 */

const BASE_ALLOWLIST = [
  // Process basics
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "NODE_ENV",
  // Windows essentials — CLIs fail to start without these
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  // Home + temp (CLIs read their own auth/config from the user profile)
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USERNAME",
  "USER",
];

/** Variables that could silently switch a CLI to API-key billing. */
export const BILLING_SENSITIVE_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENROUTER_API_KEY",
];

export type FilteredEnvOptions = {
  /** Extra variables a specific adapter explicitly needs (values from process.env). */
  extraAllowed?: string[];
  /** Explicit overrides set by the adapter itself. */
  overrides?: Record<string, string>;
};

export function buildFilteredEnv(options: FilteredEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set(
    [...BASE_ALLOWLIST, ...(options.extraAllowed ?? [])].map((v) => v.toUpperCase())
  );
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BILLING_SENSITIVE_VARS.includes(key.toUpperCase())) continue;
    if (allowed.has(key.toUpperCase())) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    env[key] = value;
  }
  return env;
}

/** Names of billing-sensitive variables currently present in this process's environment. */
export function detectBillingSensitiveVars(): string[] {
  return BILLING_SENSITIVE_VARS.filter(
    (name) => process.env[name] !== undefined && process.env[name] !== ""
  );
}
