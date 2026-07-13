import { newId } from "@omni/shared";
import type { PrismaClient } from "@omni/database";
import { nextReview, qualityFromScore, updateMastery } from "./spaced-review.js";

export type QuizGradeResult = {
  attemptId: string;
  score: number; // 0..1
  perQuestion: {
    questionId: string;
    correct: boolean;
    yourAnswer: string;
    correctAnswer: string;
    explanation: string | null;
  }[];
};

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s.,-]/gu, "").replace(/\s+/g, " ").trim();
}

/** Deterministic grading: exact/containment match for short answers, exact for MC. */
export function gradeAnswer(kind: string, answer: string, correct: string): boolean {
  const a = normalizeAnswer(answer);
  const c = normalizeAnswer(correct);
  if (!a) return false;
  if (kind === "multiple-choice") return a === c;
  if (a === c) return true;
  // Short answers: accept when the key phrase of the model answer appears.
  const keyTokens = c.split(" ").filter((t) => t.length > 3);
  if (keyTokens.length === 0) return a.includes(c);
  const hits = keyTokens.filter((t) => a.includes(t)).length;
  return hits / keyTokens.length >= 0.6;
}

export async function submitQuiz(
  prisma: PrismaClient,
  quizId: string,
  answers: { questionId: string; answer: string }[]
): Promise<QuizGradeResult> {
  const quiz = await prisma.quiz.findUniqueOrThrow({
    where: { id: quizId },
    include: { questions: true, lesson: { include: { unit: true } } },
  });

  const perQuestion = quiz.questions.map((question) => {
    const submitted = answers.find((a) => a.questionId === question.id)?.answer ?? "";
    const correct = gradeAnswer(question.kind, submitted, question.correctAnswer);
    return {
      questionId: question.id,
      correct,
      yourAnswer: submitted,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
    };
  });
  const score = quiz.questions.length > 0 ? perQuestion.filter((q) => q.correct).length / quiz.questions.length : 0;

  const attempt = await prisma.quizAttempt.create({
    data: {
      id: newId("qa"),
      quizId,
      answersJson: answers,
      score,
      feedbackJson: perQuestion,
    },
  });

  // Mastery + spaced review per concept.
  const planId = quiz.lesson?.unit ? (await prisma.learningUnit.findUnique({ where: { id: quiz.lesson.unitId }, include: { plan: true } }))?.plan.id : undefined;
  const conceptKeys = [...new Set(quiz.questions.map((q) => q.conceptKey).filter((k): k is string => Boolean(k)))];
  if (planId) {
    for (const conceptKey of conceptKeys) {
      const existing = await prisma.masteryRecord.findUnique({
        where: { planId_conceptKey: { planId, conceptKey } },
      });
      const mastery = updateMastery(existing?.mastery ?? 0, score, (existing?.attempts ?? 0) + 1);
      await prisma.masteryRecord.upsert({
        where: { planId_conceptKey: { planId, conceptKey } },
        create: { id: newId("mr"), planId, conceptKey, mastery, attempts: 1 },
        update: { mastery, attempts: { increment: 1 } },
      });

      const review = await prisma.reviewSchedule.findUnique({
        where: { planId_conceptKey: { planId, conceptKey } },
      });
      const next = nextReview(
        { intervalDays: review?.intervalDays ?? 1, ease: review?.ease ?? 2.5 },
        qualityFromScore(score)
      );
      const dueAt = new Date(Date.now() + next.dueInDays * 86_400_000);
      await prisma.reviewSchedule.upsert({
        where: { planId_conceptKey: { planId, conceptKey } },
        create: { id: newId("rs"), planId, conceptKey, dueAt, intervalDays: next.intervalDays, ease: next.ease },
        update: { dueAt, intervalDays: next.intervalDays, ease: next.ease },
      });
    }
  }

  return { attemptId: attempt.id, score, perQuestion };
}
