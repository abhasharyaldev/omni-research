import type { NextConfig } from "next";
import path from "node:path";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@omni/shared"],
  experimental: {
    // The run preview generates a research plan via the AI provider, which can
    // take ~60s. Next's rewrite proxy defaults to a 30s timeout and returns a
    // plain-text 500 ("Request failed (500)") when the upstream is slower, so
    // raise it well past the slowest realistic plan+discovery time.
    proxyTimeout: 180_000,
  },
  async rewrites() {
    // The browser talks to the Next server only; /api is proxied to the local
    // Fastify API so cookies stay same-origin (no CORS, simpler CSRF).
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
