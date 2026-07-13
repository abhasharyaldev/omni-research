import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  transpilePackages: ["@omni/shared"],
  async rewrites() {
    // The browser talks to the Next server only; /api is proxied to the local
    // Fastify API so cookies stay same-origin (no CORS, simpler CSRF).
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
