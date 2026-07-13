/** Redact common secret formats from logs, prompts, and error messages. */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /sk-ant-[a-zA-Z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /ghp_[A-Za-z0-9]{30,}/g, // GitHub PATs
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
  /(?<=bearer\s)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /(?<=(?:password|passwd|pwd|secret|token|api[_-]?key|auth)[=:]\s?)[^\s&"']{6,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g, // connection-string credentials
  /redis:\/\/[^:\s]*:[^@\s]+@/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Redact values of known-sensitive keys inside a flat object (for structured logs). */
const SENSITIVE_KEY_RE = /(password|secret|token|api[_-]?key|authorization|cookie|credential)/i;

export function redactObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      out[key] = redactSecrets(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactObject(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
