import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma, recordTimelineEvent } from "@omni/database";
import { newId } from "@omni/shared";
import { MAX_IMPORT_BYTES } from "@omni/security";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";
import { IMPORT_KINDS, ImportAlreadyClaimedError, confirmImportJob, createImportJob, type ImportKind } from "../services/import-service.js";

const noteWriteSchema = z.object({
  title: z.string().trim().max(300).optional(),
  contentMd: z.string().max(200_000).default(""),
  kind: z.enum(["note", "quote", "paraphrase", "user-authored"]).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  sourceId: z.string().max(60).nullish(),
  evidenceId: z.string().max(60).nullish(),
  claimId: z.string().max(60).nullish(),
  reportId: z.string().max(60).nullish(),
  quotedText: z.string().max(5000).nullish(),
  sourceLocation: z.string().max(200).nullish(),
});

async function requireNote(noteId: string, userId: string) {
  const prisma = getPrisma();
  const note = await prisma.note.findUnique({ where: { id: noteId }, include: { project: true } });
  if (!note || note.project.ownerId !== userId) throw new ApiHttpError(404, "not-found", "Note not found");
  return note;
}

/** Verify linked entities belong to the same project (no cross-project links). */
async function assertLinksInProject(projectId: string, input: z.infer<typeof noteWriteSchema>) {
  const prisma = getPrisma();
  const checks: [string | null | undefined, () => Promise<{ projectId: string } | null>][] = [
    [input.sourceId, () => prisma.source.findUnique({ where: { id: input.sourceId! }, select: { projectId: true } })],
    [input.evidenceId, () => prisma.evidence.findUnique({ where: { id: input.evidenceId! }, select: { projectId: true } })],
    [input.claimId, () => prisma.claim.findUnique({ where: { id: input.claimId! }, select: { projectId: true } })],
    [input.reportId, () => prisma.report.findUnique({ where: { id: input.reportId! }, select: { projectId: true } })],
  ];
  for (const [id, fetch] of checks) {
    if (!id) continue;
    const row = await fetch();
    if (!row || row.projectId !== projectId) throw new ApiHttpError(400, "invalid-link", "Linked entity is not in this project");
  }
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  // ---- Research notebook ----------------------------------------------------

  app.get("/api/projects/:id/notes", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const query = request.query as { q?: string; tag?: string; archived?: string; pinned?: string; sort?: string };
    const notes = await prisma.note.findMany({
      where: {
        projectId: id,
        archived: query.archived === "1",
        ...(query.pinned === "1" ? { pinned: true } : {}),
        ...(query.q
          ? { OR: [{ title: { contains: query.q, mode: "insensitive" } }, { contentMd: { contains: query.q, mode: "insensitive" } }] }
          : {}),
      },
      include: {
        source: { select: { id: true, title: true, url: true } },
        claim: { select: { id: true, text: true } },
        evidence: { select: { id: true, claim: true } },
        report: { select: { id: true, title: true } },
      },
      orderBy:
        query.sort === "created" ? [{ pinned: "desc" }, { createdAt: "desc" }] : [{ pinned: "desc" }, { updatedAt: "desc" }],
      take: 200,
    });
    const filtered = query.tag ? notes.filter((n) => Array.isArray(n.tags) && (n.tags as string[]).includes(query.tag!)) : notes;
    return { notes: filtered };
  });

  app.post("/api/projects/:id/notes", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const input = noteWriteSchema.parse(request.body ?? {});
    await assertLinksInProject(id, input);
    const note = await prisma.note.create({
      data: {
        id: newId("note"),
        projectId: id,
        title: input.title,
        contentMd: input.contentMd,
        kind: input.kind ?? (input.quotedText ? "quote" : "note"),
        tags: input.tags ?? [],
        pinned: input.pinned ?? false,
        sourceId: input.sourceId ?? undefined,
        evidenceId: input.evidenceId ?? undefined,
        claimId: input.claimId ?? undefined,
        reportId: input.reportId ?? undefined,
        quotedText: input.quotedText ?? undefined,
        sourceLocation: input.sourceLocation ?? undefined,
      },
    });
    await recordTimelineEvent(prisma, {
      projectId: id,
      type: "note-created",
      summary: `Note created: ${(input.title ?? input.contentMd.slice(0, 60)) || "(untitled)"}`,
      entityType: "note",
      entityId: note.id,
    });
    await audit(user.id, "note.create", "note", note.id, request);
    return { note };
  });

  app.patch("/api/notes/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const existing = await requireNote(id, user.id);
    const input = noteWriteSchema.partial().parse(request.body ?? {});
    await assertLinksInProject(existing.projectId, input as z.infer<typeof noteWriteSchema>);
    const note = await prisma.note.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.contentMd !== undefined ? { contentMd: input.contentMd } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
        ...(input.claimId !== undefined ? { claimId: input.claimId } : {}),
        ...(input.reportId !== undefined ? { reportId: input.reportId } : {}),
        ...(input.quotedText !== undefined ? { quotedText: input.quotedText } : {}),
        ...(input.sourceLocation !== undefined ? { sourceLocation: input.sourceLocation } : {}),
      },
    });
    return { note };
  });

  app.delete("/api/notes/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireNote(id, user.id);
    await prisma.note.delete({ where: { id } });
    await audit(user.id, "note.delete", "note", id, request);
    return { ok: true };
  });

  /** Promote a note into a claim (research question / assertion to track). */
  app.post("/api/notes/:id/promote-to-claim", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const note = await requireNote(id, user.id);
    const text = (note.title ?? note.contentMd).trim().slice(0, 490);
    if (!text) throw new ApiHttpError(400, "empty-note", "The note has no text to promote");
    const claim = await prisma.claim.create({
      data: {
        id: newId("clm"),
        projectId: note.projectId,
        text,
        statementKind: "uncertain",
        statusExplanation: `Created from note ${note.id}; not yet checked against evidence.`,
      },
    });
    await prisma.note.update({ where: { id }, data: { claimId: claim.id } });
    await recordTimelineEvent(prisma, {
      projectId: note.projectId,
      type: "claim-created",
      summary: `Claim created from note: ${text.slice(0, 80)}`,
      entityType: "claim",
      entityId: claim.id,
    });
    return { claim };
  });

  // ---- Project timeline -------------------------------------------------------

  app.get("/api/projects/:id/timeline", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const query = request.query as { type?: string; before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
    const events = await prisma.timelineEvent.findMany({
      where: {
        projectId: id,
        ...(query.type ? { type: query.type } : {}),
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const hasMore = events.length > limit;
    return { events: events.slice(0, limit), hasMore, nextBefore: hasMore ? events[limit - 1]!.createdAt : null };
  });

  // ---- Universal import -------------------------------------------------------

  app.post("/api/projects/:id/imports", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const body = z
      .object({
        content: z.string().min(1).max(MAX_IMPORT_BYTES),
        kind: z.enum(IMPORT_KINDS as unknown as [string, ...string[]]).optional(),
        filename: z.string().max(300).optional(),
      })
      .parse(request.body ?? {});
    try {
      const result = await createImportJob({
        projectId: id,
        userId: user.id,
        content: body.content,
        kind: body.kind as ImportKind | undefined,
        filename: body.filename,
      });
      await audit(user.id, "import.create", "import", result.jobId, request, { kind: body.kind, duplicate: Boolean(result.duplicateOfJobId) });
      return result;
    } catch (err) {
      throw new ApiHttpError(400, "import-rejected", (err as Error).message);
    }
  });

  app.get("/api/projects/:id/imports", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    await requireProject(id, user.id);
    const jobs = await prisma.importJob.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, kind: true, status: true, filename: true, byteSize: true, error: true, createdAt: true },
    });
    return { jobs };
  });

  app.get("/api/imports/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const job = await prisma.importJob.findUnique({ where: { id }, include: { items: { orderBy: { index: "asc" } }, project: true } });
    if (!job || job.project.ownerId !== user.id) throw new ApiHttpError(404, "not-found", "Import job not found");
    const { optionsJson: _omit, project: _p, ...rest } = job as Record<string, unknown>;
    return { job: rest };
  });

  app.post("/api/imports/:id/confirm", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const job = await prisma.importJob.findUnique({ where: { id }, include: { project: true } });
    if (!job || job.project.ownerId !== user.id) throw new ApiHttpError(404, "not-found", "Import job not found");
    try {
      const counts = await confirmImportJob(id);
      await audit(user.id, "import.confirm", "import", id, request, counts);
      return { counts };
    } catch (err) {
      if (err instanceof ImportAlreadyClaimedError) {
        throw new ApiHttpError(409, "import-already-claimed", err.message);
      }
      throw new ApiHttpError(400, "import-failed", (err as Error).message);
    }
  });

  app.post("/api/imports/:id/cancel", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const job = await prisma.importJob.findUnique({ where: { id }, include: { project: true } });
    if (!job || job.project.ownerId !== user.id) throw new ApiHttpError(404, "not-found", "Import job not found");
    const cancelled = await prisma.importJob.updateMany({
      where: { id, status: "preview-ready" },
      data: { status: "cancelled", optionsJson: {} },
    });
    if (cancelled.count === 0) throw new ApiHttpError(409, "not-cancellable", `Job is ${job.status}`);
    return { ok: true };
  });
}
