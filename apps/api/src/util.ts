import type { FastifyRequest } from "fastify";
import { getPrisma } from "@omni/database";
import { newId } from "@omni/shared";

export class ApiHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export async function audit(
  userId: string | null,
  action: string,
  entity?: string,
  entityId?: string,
  request?: FastifyRequest,
  detail?: Record<string, unknown>
): Promise<void> {
  const prisma = getPrisma();
  await prisma.auditLog
    .create({
      data: {
        id: newId("aud"),
        userId,
        action,
        entity,
        entityId,
        detailJson: detail as object | undefined,
        requestId: request?.id,
        ip: request?.ip,
      },
    })
    .catch(() => undefined); // audit failures never break the request
}

/** Load a project and enforce ownership server-side. */
export async function requireProject(projectId: string, userId: string) {
  const prisma = getPrisma();
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.ownerId !== userId) {
    // Same error for "missing" and "not yours": no existence leaks.
    throw new ApiHttpError(404, "not-found", "Project not found");
  }
  return project;
}

export async function requireRun(runId: string, userId: string) {
  const prisma = getPrisma();
  const run = await prisma.researchRun.findUnique({ where: { id: runId }, include: { project: true } });
  if (!run || run.project.ownerId !== userId) {
    throw new ApiHttpError(404, "not-found", "Research run not found");
  }
  return run;
}

export async function requireSource(sourceId: string, userId: string) {
  const prisma = getPrisma();
  const source = await prisma.source.findUnique({ where: { id: sourceId }, include: { project: true } });
  if (!source || source.project.ownerId !== userId) {
    throw new ApiHttpError(404, "not-found", "Source not found");
  }
  return source;
}
