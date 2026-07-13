/**
 * Tiny static server for the local fixture website (tests, setup wizard,
 * demo). Binds to 127.0.0.1 only.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "websites");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".rss": "application/rss+xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
};

export type FixtureServer = { port: number; server: Server; close: () => Promise<void> };

export async function startFixtureServer(port = 4799): Promise<FixtureServer> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      // Redirect fixture for redirect-validation tests.
      if (filePath === "/redirect-to-internal") {
        res.writeHead(302, { location: "http://127.0.0.1:1/" });
        return res.end();
      }
      if (filePath === "/redirect-to-article") {
        res.writeHead(302, { location: "/articles/spaced-repetition.html" });
        return res.end();
      }
      if (filePath === "/slow") {
        await new Promise((r) => setTimeout(r, 5000));
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<html><body>slow page</body></html>");
      }
      const resolved = path.normalize(path.join(FIXTURES_ROOT, filePath));
      if (!resolved.startsWith(FIXTURES_ROOT)) {
        res.writeHead(403);
        return res.end("forbidden");
      }
      const body = await readFile(resolved);
      res.writeHead(200, {
        "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
        "content-length": body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as { port: number }).port;
  return {
    port: actualPort,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
