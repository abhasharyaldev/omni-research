import dns from "node:dns/promises";
import net from "node:net";
import { isForbiddenIp } from "./ip-ranges.js";

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRejectReason; detail: string };

export type UrlRejectReason =
  | "invalid-url"
  | "forbidden-protocol"
  | "embedded-credentials"
  | "forbidden-hostname"
  | "forbidden-ip"
  | "dns-failure"
  | "domain-blocked"
  | "not-in-allowlist";

/**
 * Test hook: fixture servers run on 127.0.0.1, which is otherwise forbidden.
 * Only honored when OMNI_ALLOW_LOOPBACK_FOR_TESTS=1 (never set in production).
 */
export function loopbackAllowedForTests(): boolean {
  return process.env.OMNI_ALLOW_LOOPBACK_FOR_TESTS === "1";
}

function ipAllowed(ip: string): boolean {
  if (!isForbiddenIp(ip)) return true;
  if (loopbackAllowedForTests()) {
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
  }
  return false;
}

const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

const FORBIDDEN_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".corp",
  ".home",
  ".lan",
  ".onion",
];

export type UrlPolicy = {
  allowDomains?: string[]; // when non-empty, only these (and subdomains for *. entries) are allowed
  blockDomains?: string[];
};

function hostnameMatches(hostname: string, pattern: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = hostname.toLowerCase();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p || h.endsWith(`.${p}`);
}

/**
 * Syntactic validation: protocol, credentials, hostname shape, literal IPs,
 * allow/block lists. Does NOT hit the network. WHATWG URL parsing already
 * canonicalizes integer/hex/octal IPv4 forms to dotted-decimal, so
 * `http://2130706433` and `http://0x7f000001` arrive here as `127.0.0.1`.
 */
export function validateUrlSyntax(rawUrl: string, policy: UrlPolicy = {}): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid-url", detail: `Cannot parse URL` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "forbidden-protocol",
      detail: `Protocol ${url.protocol} is not allowed; only http and https`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: "embedded-credentials",
      detail: "URLs with embedded credentials are not allowed",
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "invalid-url", detail: "Empty hostname" };

  // Literal IP host (v4 dotted or [v6])
  const bareV6 = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(bareV6)) {
    if (!ipAllowed(bareV6)) {
      return {
        ok: false,
        reason: "forbidden-ip",
        detail: `IP address ${bareV6} is in a forbidden range`,
      };
    }
  } else {
    if (FORBIDDEN_HOSTNAMES.has(hostname)) {
      return { ok: false, reason: "forbidden-hostname", detail: `Hostname ${hostname} is forbidden` };
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
      if (hostname.endsWith(suffix)) {
        return {
          ok: false,
          reason: "forbidden-hostname",
          detail: `Hostname suffix ${suffix} is forbidden`,
        };
      }
    }
    if (!hostname.includes(".")) {
      return {
        ok: false,
        reason: "forbidden-hostname",
        detail: "Single-label hostnames (likely internal) are forbidden",
      };
    }
  }

  if (policy.blockDomains?.some((d) => hostnameMatches(hostname, d))) {
    return { ok: false, reason: "domain-blocked", detail: `Domain ${hostname} is blocked` };
  }
  if (
    policy.allowDomains &&
    policy.allowDomains.length > 0 &&
    !policy.allowDomains.some((d) => hostnameMatches(hostname, d))
  ) {
    return {
      ok: false,
      reason: "not-in-allowlist",
      detail: `Domain ${hostname} is not in the allowlist`,
    };
  }

  return { ok: true, url };
}

export type ResolvedVerdict =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: UrlRejectReason; detail: string };

/**
 * Full validation: syntax + DNS resolution. EVERY resolved address must be
 * public. Returns the resolved addresses so callers can pin connections.
 */
export async function validateUrlResolved(
  rawUrl: string,
  policy: UrlPolicy = {}
): Promise<ResolvedVerdict> {
  const syntax = validateUrlSyntax(rawUrl, policy);
  if (!syntax.ok) return syntax;
  const { url } = syntax;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    if (!ipAllowed(hostname)) {
      return { ok: false, reason: "forbidden-ip", detail: `IP ${hostname} is forbidden` };
    }
    return { ok: true, url, addresses: [hostname] };
  }

  let records: { address: string }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return {
      ok: false,
      reason: "dns-failure",
      detail: `DNS lookup failed for ${hostname}: ${(err as Error).message}`,
    };
  }
  if (records.length === 0) {
    return { ok: false, reason: "dns-failure", detail: `No DNS records for ${hostname}` };
  }
  for (const record of records) {
    if (!ipAllowed(record.address)) {
      return {
        ok: false,
        reason: "forbidden-ip",
        detail: `${hostname} resolves to forbidden address ${record.address}`,
      };
    }
  }
  return { ok: true, url, addresses: records.map((r) => r.address) };
}
