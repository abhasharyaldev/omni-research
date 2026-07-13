import dns from "node:dns";
import { Agent, request as undiciRequest } from "undici";
import { isForbiddenIp } from "./ip-ranges.js";
import {
  loopbackAllowedForTests,
  validateUrlSyntax,
  type UrlPolicy,
} from "./url-safety.js";

export class SafeFetchError extends Error {
  constructor(
    public readonly code:
      | "unsafe-url"
      | "redirect-blocked"
      | "too-many-redirects"
      | "response-too-large"
      | "timeout"
      | "unsupported-content-type"
      | "request-failed",
    message: string
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/**
 * DNS-rebinding-safe lookup passed to the socket layer: whatever the resolver
 * returns at CONNECT time is checked again, so a hostname cannot pass
 * validation and then re-resolve to an internal address.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, undefined as any);
    const records = addresses as dns.LookupAddress[];
    for (const record of records) {
      const forbidden =
        isForbiddenIp(record.address) &&
        !(
          loopbackAllowedForTests() &&
          (record.address === "127.0.0.1" ||
            record.address === "::1" ||
            record.address.startsWith("::ffff:127."))
        );
      if (forbidden) {
        const error: NodeJS.ErrnoException = new Error(
          `Blocked connection: ${hostname} resolved to forbidden address ${record.address}`
        );
        error.code = "EFORBIDDENADDR";
        return callback(error, undefined as any);
      }
    }
    if ((options as { all?: boolean }).all) {
      callback(null, records);
    } else {
      const first = records[0];
      if (!first) {
        const error: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`);
        error.code = "ENOTFOUND";
        return callback(error, undefined as any);
      }
      callback(null, first.address, first.family);
    }
  });
}

let sharedAgent: Agent | undefined;
function getAgent(): Agent {
  if (!sharedAgent) {
    // undici does not follow redirects by default — we handle every hop
    // manually so each one is validated.
    sharedAgent = new Agent({
      connect: { lookup: guardedLookup as any, timeout: 15_000 },
    });
  }
  return sharedAgent;
}

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  policy?: UrlPolicy;
  allowedContentTypes?: string[]; // prefix match on the media type, e.g. "text/html"
  userAgent?: string;
};

export type SafeFetchResult = {
  status: number;
  finalUrl: string;
  redirectChain: string[];
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  truncated: boolean;
};

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Fetch a URL with layered SSRF protection: syntax validation on every hop,
 * connect-time DNS guarding, manual redirect validation, response size caps,
 * and a content-type allowlist.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    method = "GET",
    timeoutMs = 30_000,
    maxBytes = 10_000_000,
    maxRedirects = 5,
    policy = {},
    allowedContentTypes,
    userAgent = "OmniResearchBot/1.0",
  } = options;

  const redirectChain: string[] = [];
  let currentUrl = rawUrl;
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = validateUrlSyntax(currentUrl, policy);
    if (!verdict.ok) {
      throw new SafeFetchError(
        hop === 0 ? "unsafe-url" : "redirect-blocked",
        `${hop === 0 ? "URL rejected" : "Redirect rejected"}: ${verdict.detail}`
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError("timeout", `Timed out fetching ${rawUrl}`);

    let response;
    try {
      response = await undiciRequest(verdict.url, {
        method,
        dispatcher: getAgent(),
        headersTimeout: Math.min(remaining, timeoutMs),
        bodyTimeout: Math.min(remaining, timeoutMs),
        headers: {
          "user-agent": userAgent,
          accept: "*/*",
          ...options.headers,
        },
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message.includes("forbidden address")) {
        throw new SafeFetchError("unsafe-url", message);
      }
      throw new SafeFetchError("request-failed", `Request to ${currentUrl} failed: ${message}`);
    }

    const status = response.statusCode;
    if (status >= 300 && status < 400) {
      const location = headerValue(response.headers as any, "location");
      await response.body.dump();
      if (!location) {
        throw new SafeFetchError("request-failed", `Redirect ${status} without Location header`);
      }
      const nextUrl = new URL(location, verdict.url).toString();
      redirectChain.push(currentUrl);
      currentUrl = nextUrl;
      if (hop === maxRedirects) {
        throw new SafeFetchError("too-many-redirects", `Exceeded ${maxRedirects} redirects`);
      }
      continue;
    }

    const contentTypeRaw = headerValue(response.headers as any, "content-type");
    const mediaType = contentTypeRaw.split(";")[0]?.trim().toLowerCase() ?? "";
    if (allowedContentTypes && status < 400) {
      const permitted = allowedContentTypes.some((allowed) => mediaType.startsWith(allowed));
      if (!permitted) {
        await response.body.dump();
        throw new SafeFetchError(
          "unsupported-content-type",
          `Content type "${mediaType || "unknown"}" is not in the allowlist`
        );
      }
    }

    const declaredLength = Number(headerValue(response.headers as any, "content-length") || "0");
    if (declaredLength > maxBytes) {
      await response.body.dump();
      throw new SafeFetchError(
        "response-too-large",
        `Declared content length ${declaredLength} exceeds limit ${maxBytes}`
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        truncated = true;
        response.body.destroy();
        throw new SafeFetchError(
          "response-too-large",
          `Response exceeded ${maxBytes} bytes and was aborted`
        );
      }
      chunks.push(buf);
      if (Date.now() > deadline) {
        response.body.destroy();
        throw new SafeFetchError("timeout", `Timed out reading body of ${currentUrl}`);
      }
    }

    const flatHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      flatHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    }

    return {
      status,
      finalUrl: currentUrl,
      redirectChain,
      headers: flatHeaders,
      contentType: mediaType,
      body: Buffer.concat(chunks),
      truncated,
    };
  }

  throw new SafeFetchError("too-many-redirects", `Exceeded ${maxRedirects} redirects`);
}
