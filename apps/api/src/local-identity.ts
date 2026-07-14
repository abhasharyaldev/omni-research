import { getPrisma } from "@omni/database";
import { newId } from "@omni/shared";
import type { AuthedUser } from "./auth.js";

/**
 * Account-free local mode.
 *
 * `OMNI_DEPLOYMENT_MODE=local` (the default) resolves every request to one
 * stable local identity, server-side — the browser never supplies a user id.
 * `hosted` keeps the full session/auth behavior and never inherits the local
 * bypass.
 *
 * Existing-data preservation: if users already exist (e.g. the seeded demo
 * account or a previously registered account), the OLDEST existing user
 * becomes the local identity — nothing is deleted, merged, or re-owned. A
 * fresh install creates one deterministic local user; creation is
 * concurrency-safe (upsert on the unique email).
 */

export const LOCAL_USER_EMAIL = "local@omniresearch.local";

export type DeploymentMode = "local" | "hosted";

export function deploymentMode(): DeploymentMode {
  return (process.env.OMNI_DEPLOYMENT_MODE ?? "local") === "hosted" ? "hosted" : "local";
}

let cachedLocalUser: AuthedUser | null = null;

export function resetLocalIdentityCache(): void {
  cachedLocalUser = null;
}

export async function getLocalUser(): Promise<AuthedUser> {
  if (cachedLocalUser) return cachedLocalUser;
  const prisma = getPrisma();

  const existing = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  const user =
    existing ??
    (await prisma.user.upsert({
      where: { email: LOCAL_USER_EMAIL },
      update: {},
      create: {
        id: newId("usr"),
        email: LOCAL_USER_EMAIL,
        // Random unusable password hash: local mode never authenticates by
        // password, and hosted mode would require a real login.
        passwordHash: `local-mode-no-password-${newId("x")}`,
        displayName: "Local researcher",
      },
    }));

  cachedLocalUser = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    defaultProvider: user.defaultProvider,
  };
  return cachedLocalUser;
}

/**
 * Fail closed: account-free mode must never be reachable beyond loopback.
 * Called with the host the server is about to bind.
 */
export function assertLocalBindSafety(host: string): void {
  if (deploymentMode() !== "local") return;
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopback.has(host)) {
    throw new Error(
      `OMNI_DEPLOYMENT_MODE=local is account-free and MUST bind to loopback; refusing to listen on "${host}". ` +
        `Set OMNI_DEPLOYMENT_MODE=hosted (with real authentication) for any non-local binding.`
    );
  }
}
