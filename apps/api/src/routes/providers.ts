import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { PROVIDER_IDS, newId, type ProviderId } from "@omni/shared";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit } from "../util.js";

function parseProviderId(raw: string): ProviderId {
  if (!PROVIDER_IDS.includes(raw as ProviderId)) {
    throw new ApiHttpError(404, "unknown-provider", `Unknown provider "${raw}"`);
  }
  return raw as ProviderId;
}

export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const manager = getProviderManager();

  app.get("/api/providers", async (request) => {
    const user = requireUser(request);
    const cached = await prisma.providerConnectionStatus.findMany();
    return {
      defaultProvider: user.defaultProvider,
      providers: PROVIDER_IDS.map((id) => {
        const row = cached.find((c) => c.providerId === id);
        return {
          id,
          displayName: manager.get(id).displayName,
          statusCode: row?.statusCode ?? "not-installed",
          installed: row?.installed ?? false,
          version: row?.version ?? null,
          authenticated: row?.authenticated ?? false,
          detail: row?.detail ?? "Not checked yet — run a check",
          capabilities: row?.capabilities ?? null,
          lastCheckedAt: row?.lastCheckedAt ?? null,
        };
      }),
    };
  });

  app.post("/api/providers/:id/check", async (request) => {
    const user = requireUser(request);
    const id = parseProviderId((request.params as { id: string }).id);
    const report = await manager.status(id);
    await prisma.providerConnectionStatus.upsert({
      where: { providerId: id },
      create: {
        id: newId("pcs"),
        providerId: id,
        installed: report.installation.installed,
        version: report.installation.version,
        authenticated: report.authentication.authenticated === true,
        statusCode: report.statusCode,
        detail: [report.installation.detail, report.authentication.detail, ...report.authentication.billingWarnings]
          .filter(Boolean)
          .join(" | ")
          .slice(0, 1900),
        capabilities: report.capabilities as object | undefined,
        lastCheckedAt: new Date(),
      },
      update: {
        installed: report.installation.installed,
        version: report.installation.version,
        authenticated: report.authentication.authenticated === true,
        statusCode: report.statusCode,
        detail: [report.installation.detail, report.authentication.detail, ...report.authentication.billingWarnings]
          .filter(Boolean)
          .join(" | ")
          .slice(0, 1900),
        capabilities: report.capabilities as object | undefined,
        lastCheckedAt: new Date(),
      },
    });
    await audit(user.id, "provider.check", "provider", id, request);
    return { report };
  });

  app.post("/api/providers/:id/test", async (request) => {
    const user = requireUser(request);
    const id = parseProviderId((request.params as { id: string }).id);
    // Explicit user action: a live test may count against subscription usage.
    const result = await manager.testConnection(id);
    if (result.ok) {
      await prisma.providerConnectionStatus.upsert({
        where: { providerId: id },
        create: {
          id: newId("pcs"),
          providerId: id,
          installed: true,
          authenticated: true,
          statusCode: "ready",
          detail: result.detail,
          lastCheckedAt: new Date(),
        },
        update: { authenticated: true, statusCode: "ready", detail: result.detail, lastCheckedAt: new Date() },
      });
    }
    await audit(user.id, "provider.test", "provider", id, request, { ok: result.ok });
    return { result };
  });

  app.post("/api/providers/:id/set-default", async (request) => {
    const user = requireUser(request);
    const id = parseProviderId((request.params as { id: string }).id);
    await prisma.user.update({ where: { id: user.id }, data: { defaultProvider: id } });
    await audit(user.id, "provider.set-default", "provider", id, request);
    return { ok: true, defaultProvider: id };
  });
}
