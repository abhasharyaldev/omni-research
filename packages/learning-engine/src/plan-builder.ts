import { z } from "zod";
import { newId, type CreateLearningPlanInput, type ProviderId } from "@omni/shared";
import type { PrismaClient } from "@omni/database";
import type { ProviderManager } from "@omni/ai-providers";

const lessonOutputSchema = z.object({
  objective: z.string().min(1).max(1000),
  whyItMatters: z.string().max(2000).default(""),
  contentMd: z.string().min(1).max(60_000),
  guidedPractice: z.array(z.string().max(2000)).max(10).default([]),
  independentPractice: z.array(z.string().max(2000)).max(10).default([]),
  quiz: z
    .array(
      z.object({
        prompt: z.string().min(1).max(2000),
        kind: z.enum(["short-answer", "multiple-choice"]).default("short-answer"),
        choices: z.array(z.string().max(500)).max(6).optional(),
        correctAnswer: z.string().min(1).max(2000),
        explanation: z.string().max(2000).default(""),
      })
    )
    .max(10)
    .default([]),
  masteryCriteria: z.string().max(1000).default(""),
  estimatedMinutes: z.number().int().min(5).max(600).default(30),
});

const LESSON_SCHEMA_DESCRIPTION = `{
  "objective": "string",
  "whyItMatters": "string",
  "contentMd": "markdown with sections: Simple explanation, Detailed explanation, Important rules/formulas, Worked examples, Common mistakes, Real-world application. Write ORIGINAL explanations — never copy passages from sources.",
  "guidedPractice": ["string"],
  "independentPractice": ["string"],
  "quiz": [{ "prompt": "string", "kind": "short-answer|multiple-choice", "choices": ["string"], "correctAnswer": "string", "explanation": "string" }],
  "masteryCriteria": "string",
  "estimatedMinutes": 30
}`;

const skillPlanOutputSchema = z.object({
  units: z
    .array(
      z.object({
        title: z.string().min(1).max(300),
        summary: z.string().max(2000).default(""),
        lessons: z.array(z.string().min(1).max(300)).min(1).max(12),
        milestoneProject: z
          .object({
            title: z.string().min(1).max(300),
            brief: z.string().min(1).max(4000),
            milestone: z.boolean().default(false),
          })
          .optional(),
      })
    )
    .min(1)
    .max(16),
});

const SKILL_PLAN_SCHEMA_DESCRIPTION = `{
  "units": [{
    "title": "string",
    "summary": "string",
    "lessons": ["lesson title"],
    "milestoneProject": { "title": "string", "brief": "what the learner builds/writes/demonstrates", "milestone": true }
  }]
}`;

/**
 * Build a learning plan: units and lesson skeletons immediately (so the plan
 * is inspectable), with full lesson content generated on demand per lesson —
 * one concept at a time, adapted to the learner's level.
 */
export async function createLearningPlan(
  prisma: PrismaClient,
  providers: ProviderManager,
  input: CreateLearningPlanInput,
  providerId?: ProviderId
): Promise<string> {
  const provider = providers.get(providerId ?? providers.defaultId());
  const weeks = input.deadline
    ? Math.max(1, Math.min(16, Math.ceil((input.deadline.getTime() - Date.now()) / (7 * 86_400_000))))
    : 4;

  const skeleton = await provider.generateStructured(
    {
      requestId: `skillplan-${newId()}`,
      taskKind: "skill-plan",
      instructions: [
        `Design a ${weeks}-week ${input.kind === "school-subject" ? "study" : "project-based skill"} plan for "${input.subject}".`,
        `Learner: currently ${input.currentLevel}, targeting ${input.targetLevel}, ${input.hoursPerWeek} hours/week.`,
        input.knownTopics.length ? `Already understands: ${input.knownTopics.join(", ")}.` : "",
        input.difficultTopics.length ? `Finds difficult: ${input.difficultTopics.join(", ")}.` : "",
        "Order units so prerequisites come first. Every major unit ends with something the learner builds, writes, solves, presents, or demonstrates.",
      ]
        .filter(Boolean)
        .join("\n"),
      context: { subject: input.subject, skill: input.subject, weeks },
      schemaDescription: SKILL_PLAN_SCHEMA_DESCRIPTION,
    },
    skillPlanOutputSchema
  );

  const plan = await prisma.learningPlan.create({
    data: {
      id: newId("lp"),
      projectId: input.projectId,
      subject: input.subject,
      kind: input.kind,
      currentLevel: input.currentLevel,
      targetLevel: input.targetLevel,
      deadline: input.deadline,
      hoursPerWeek: input.hoursPerWeek,
      knownTopics: input.knownTopics,
      difficultTopics: input.difficultTopics,
      learningStyle: input.learningStyle,
    },
  });

  for (const [unitIndex, unit] of skeleton.units.entries()) {
    const unitRow = await prisma.learningUnit.create({
      data: {
        id: newId("lu"),
        planId: plan.id,
        title: unit.title.slice(0, 290),
        summary: unit.summary || null,
        order: unitIndex,
      },
    });
    for (const [lessonIndex, lessonTitle] of unit.lessons.entries()) {
      const previousLesson = lessonIndex > 0 ? unit.lessons[lessonIndex - 1] : undefined;
      const previousUnit = unitIndex > 0 ? skeleton.units[unitIndex - 1]?.title : undefined;
      const prerequisites: string[] = previousLesson ? [previousLesson] : previousUnit ? [previousUnit] : [];
      await prisma.lesson.create({
        data: {
          id: newId("les"),
          unitId: unitRow.id,
          title: lessonTitle.slice(0, 290),
          prerequisites,
          contentMd: "", // generated on demand via generateLessonContent
          order: lessonIndex,
        },
      });
    }
    if (unit.milestoneProject) {
      await prisma.skillProject.create({
        data: {
          id: newId("sp"),
          planId: plan.id,
          title: unit.milestoneProject.title.slice(0, 290),
          brief: unit.milestoneProject.brief,
          milestone: unit.milestoneProject.milestone,
          order: unitIndex,
        },
      });
    }
  }
  return plan.id;
}

/** Generate the full body of one lesson (idempotent: skips if already generated). */
export async function generateLessonContent(
  prisma: PrismaClient,
  providers: ProviderManager,
  lessonId: string,
  providerId?: ProviderId
): Promise<void> {
  const lesson = await prisma.lesson.findUniqueOrThrow({
    where: { id: lessonId },
    include: { unit: { include: { plan: true } } },
  });
  if (lesson.contentMd.trim()) return;
  const plan = lesson.unit.plan;
  const provider = providers.get(providerId ?? providers.defaultId());

  const output = await provider.generateStructured(
    {
      requestId: `lesson-${lessonId}`,
      taskKind: "lesson-generation",
      instructions: [
        `Write one complete lesson: "${lesson.title}" (unit: "${lesson.unit.title}", subject: "${plan.subject}").`,
        `Learner level: ${plan.currentLevel ?? "beginner"}; style preference: ${plan.learningStyle ?? "none stated"}.`,
        "Teach ONE concept. Include: simple explanation, detailed explanation, important rules/formulas, at least one worked example, common mistakes, guided practice, independent practice, a short quiz with answer explanations, real-world application, and mastery criteria.",
        "Write original explanations — never copy long passages from any source.",
      ].join("\n"),
      context: {
        subject: plan.subject,
        unitTitle: lesson.unit.title,
        lessonTitle: lesson.title,
        level: plan.currentLevel ?? "beginner",
      },
      schemaDescription: LESSON_SCHEMA_DESCRIPTION,
    },
    lessonOutputSchema
  );

  await prisma.lesson.update({
    where: { id: lessonId },
    data: {
      objective: output.objective,
      whyItMatters: output.whyItMatters || null,
      contentMd: output.contentMd,
      masteryCriteria: output.masteryCriteria || null,
      estimatedMinutes: output.estimatedMinutes,
    },
  });
  for (const [index, practice] of output.guidedPractice.entries()) {
    await prisma.exercise.create({
      data: { id: newId("ex"), lessonId, kind: "guided", prompt: practice, order: index },
    });
  }
  for (const [index, practice] of output.independentPractice.entries()) {
    await prisma.exercise.create({
      data: { id: newId("ex"), lessonId, kind: "independent", prompt: practice, order: index },
    });
  }
  if (output.quiz.length > 0) {
    const quiz = await prisma.quiz.create({
      data: { id: newId("qz"), lessonId, title: `Quiz: ${lesson.title}`.slice(0, 190) },
    });
    for (const [index, q] of output.quiz.entries()) {
      await prisma.quizQuestion.create({
        data: {
          id: newId("qq"),
          quizId: quiz.id,
          prompt: q.prompt,
          kind: q.kind,
          choices: q.choices ?? undefined,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation || null,
          conceptKey: lesson.title.toLowerCase().slice(0, 80),
          order: index,
        },
      });
    }
  }
}
