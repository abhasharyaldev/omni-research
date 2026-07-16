import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const eq = trimmed.indexOf("=");
  if (eq <= 0) return undefined;

  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

  let value = trimmed.slice(eq + 1).trim();
  const quote = value[0];
  if ((quote === `"` || quote === `'`) && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

/**
 * Dependency-free .env loader for Node entrypoints. It intentionally does not
 * override real environment variables supplied by the shell or host.
 */
export function loadRootEnv(root = process.cwd()): void {
  let cursor = path.resolve(root);
  let file = path.join(cursor, ".env");
  while (!existsSync(file)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
    file = path.join(cursor, ".env");
  }
  if (process.env.OMNI_ENV_ROOT === undefined) process.env.OMNI_ENV_ROOT = cursor;

  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
