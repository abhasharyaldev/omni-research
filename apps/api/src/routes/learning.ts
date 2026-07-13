import type { FastifyInstance } from "fastify";
import { getPrisma } from "@omni/database";
import { getProviderManager } from "@omni/ai-providers";
import { createLearningPlanSchema, quizSubmitSchema, type ProviderId } from "@omni/shared";
import { createLearningPlan, generateLessonContent, submitQuiz } from "@omni/learning-engine";
import { requireUser } from "../auth.js";
import { ApiHttpError, audit, requireProject } from "../util.js";

export async function registerLearningRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const providers = getProviderManager();

  app.post("/api/learning-plans", async (request) => {
    const user = requireUser(request);
    const input = createLearningPlanSchema.parse(request.body);
    const project = await requireProject(input.projectId, user.id);
    const planId = await createLearningPlan(
      prisma,
      providers,
      input,
      (project.provider as ProviderId | null) ?? (user.defaultProvider as ProviderId)
    );
    await audit(user.id, "learning-plan.create", "learning-plan", planId, request);
    return { planId };
  });

  app.get("/api/learning-plans/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const plan = await prisma.learningPlan.findUnique({
      where: { id },
      include: {
        project: { select: { ownerId: true, id: true, title: true } },
        units: {
          orderBy: { order: "asc" },
          include: {
            lessons: {
              orderBy: { order: "asc" },
              select: { id: true, title: true, objective: true, estimatedMinutes: true, completedAt: true, order: true, contentMd: true },
            },
          },
        },
        mastery: true,
        reviews: { orderBy: { dueAt: "asc" }, take: 50 },
        skillProjects: { orderBy: { order: "asc" } },
      },
    });
    if (!plan || plan.project.ownerId !== user.id) throw new ApiHttpError(404, "not-found", "Learning plan not found");
    return {
      plan: {
        ...plan,
        units: plan.units.map((u) => ({
          ...u,
          lessons: u.lessons.map((l) => ({ ...l, hasContent: Boolean(l.contentMd.trim()), contentMd: undefined })),
        })),
      },
    };
  });

  app.patch("/api/learning-plans/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const plan = await prisma.learningPlan.findUnique({ where: { id }, include: { project: true } });
    if (!plan || plan.project.ownerId !== user.id) throw new ApiHttpError(404, "not-found", "Learning plan not found");
    const body = (request.body ?? {}) as { status?: string; hoursPerWeek?: number };
    const updated = await prisma.learningPlan.update({
      where: { id },
      data: {
        ...(body.status && ["active", "archived", "completed"].includes(body.status) ? { status: body.status } : {}),
        ...(typeof body.hoursPerWeek === "number" && body.hoursPerWeek > 0 && body.hoursPerWeek <= 80
          ? { hoursPerWeek: body.hoursPerWeek }
          : {}),
      },
    });
    return { plan: updated };
  });

  app.get("/api/lessons/:id", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const lesson = await prisma.lesson.findUnique({
      where: { id },
      include: {
        unit: { include: { plan: { include: { project: { select: { ownerId: true, provider: true } } } } } },
        exercises: { orderBy: { order: "asc" } },
        quizzes: { include: { questions: { orderBy: { order: "asc" } } } },
      },
    });
    if (!lesson || lesson.unit.plan.project.ownerId !== user.id) {
      throw new ApiHttpError(404, "not-found", "Lesson not found");
    }
    if (!lesson.contentMd.trim()) {
      // Generate on first open — one concept at a time.
      await generateLessonContent(
        prisma,
        providers,
        id,
        (lesson.unit.plan.project.provider as ProviderId | null) ?? (user.defaultProvider as ProviderId)
      );
      const refreshed = await prisma.lesson.findUnique({
        where: { id },
        include: {
          unit: true,
          exercises: { orderBy: { order: "asc" } },
          quizzes: { include: { questions: { orderBy: { order: "asc" } } } },
        },
      });
      return { lesson: sanitizeLesson(refreshed) };
    }
    return { lesson: sanitizeLesson(lesson) };
  });

  app.post("/api/lessons/:id/complete", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const lesson = await prisma.lesson.findUnique({
      where: { id },
      include: { unit: { include: { plan: { include: { project: { select: { ownerId: true } } } } } } },
    });
    if (!lesson || lesson.unit.plan.project.ownerId !== user.id) {
      throw new ApiHttpError(404, "not-found", "Lesson not found");
    }
    await prisma.lesson.update({ where: { id }, data: { completedAt: new Date() } });
    await audit(user.id, "lesson.complete", "lesson", id, request);
    return { ok: true };
  });

  app.post("/api/quizzes/:id/submit", async (request) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const quiz = await prisma.quiz.findUnique({
      where: { id },
      include: { lesson: { include: { unit: { include: { plan: { include: { project: { select: { ownerId: true } } } } } } } } },
    });
    if (!quiz || quiz.lesson?.unit.plan.project.ownerId !== user.id) {
      throw new ApiHttpError(404, "not-found", "Quiz not found");
    }
    const input = quizSubmitSchema.parse(request.body);
    const result = await submitQuiz(prisma, id, input.answers);
    await audit(user.id, "quiz.submit", "quiz", id, request, { score: result.score });
    return { result };
  });
}

function sanitizeLesson(lesson: any) {
  if (!lesson) return lesson;
  return {
    ...lesson,
    quizzes: lesson.quizzes?.map((quiz: any) => ({
      ...quiz,
      // Never send answers to the client before submission.
      questions: quiz.questions?.map((q: any) => ({
        id: q.id,
        prompt: q.prompt,
        kind: q.kind,
        choices: q.choices,
        order: q.order,
      })),
    })),
  };
}
