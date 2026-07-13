"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Markdown } from "@/components/markdown";

export default function LessonPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["lesson", id],
    queryFn: () => apiGet<{ lesson: any }>(`/api/lessons/${id}`),
    staleTime: 60_000,
  });
  const lesson = data?.lesson;
  const quiz = lesson?.quizzes?.[0];

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 pt-6">
        <div className="skeleton h-10" />
        <div className="skeleton h-64" />
        <p className="text-center text-sm" style={{ color: "var(--muted)" }}>
          Preparing lesson (first open generates the content)…
        </p>
      </div>
    );
  }
  if (!lesson) return <p className="pt-10 text-center">Lesson not found.</p>;

  const submitQuiz = async () => {
    setSubmitting(true);
    try {
      const payload = {
        answers: quiz.questions.map((q: any) => ({ questionId: q.id, answer: answers[q.id] ?? "" })),
      };
      const response = await apiPost<{ result: any }>(`/api/quizzes/${quiz.id}/submit`, payload);
      setResult(response.result);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">{lesson.title}</h1>
        {lesson.completedAt && <span className="badge badge-good">completed</span>}
        <span className="badge">~{lesson.estimatedMinutes} min</span>
        <Link href={`/learning/${lesson.unit.planId}`} className="btn ml-auto">Back to plan</Link>
      </div>

      {lesson.objective && (
        <p className="mt-3 text-sm"><span className="font-semibold">Objective:</span> {lesson.objective}</p>
      )}
      {Array.isArray(lesson.prerequisites) && lesson.prerequisites.length > 0 && (
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Prerequisites: {lesson.prerequisites.join(", ")}
        </p>
      )}
      {lesson.whyItMatters && (
        <p className="panel mt-3 p-3 text-sm" style={{ color: "var(--muted)" }}>{lesson.whyItMatters}</p>
      )}

      <div className="panel mt-5 p-6">
        <Markdown content={lesson.contentMd} />
      </div>

      {lesson.exercises?.length > 0 && (
        <div className="panel mt-4 p-5">
          <h2 className="font-bold">Practice</h2>
          {["guided", "independent"].map((kind) => {
            const items = lesson.exercises.filter((e: any) => e.kind === kind);
            if (items.length === 0) return null;
            return (
              <div key={kind} className="mt-3">
                <p className="label">{kind} practice</p>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {items.map((e: any) => <li key={e.id}>{e.prompt}</li>)}
                </ol>
              </div>
            );
          })}
        </div>
      )}

      {quiz && (
        <div className="panel mt-4 p-5">
          <h2 className="font-bold">{quiz.title}</h2>
          <div className="mt-3 space-y-4">
            {quiz.questions.map((question: any, index: number) => {
              const feedback = result?.perQuestion.find((f: any) => f.questionId === question.id);
              return (
                <div key={question.id}>
                  <p className="text-sm font-semibold">{index + 1}. {question.prompt}</p>
                  {question.kind === "multiple-choice" && Array.isArray(question.choices) ? (
                    <div className="mt-2 space-y-1">
                      {question.choices.map((choice: string) => (
                        <label key={choice} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={question.id}
                            value={choice}
                            checked={answers[question.id] === choice}
                            onChange={() => setAnswers((a) => ({ ...a, [question.id]: choice }))}
                          />
                          {choice}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      className="input mt-2"
                      value={answers[question.id] ?? ""}
                      onChange={(e) => setAnswers((a) => ({ ...a, [question.id]: e.target.value }))}
                      disabled={Boolean(result)}
                    />
                  )}
                  {feedback && (
                    <div className="mt-2 rounded-md border p-2 text-sm"
                      style={{ borderColor: feedback.correct ? "var(--good)" : "var(--bad)" }}>
                      <p style={{ color: feedback.correct ? "var(--good)" : "var(--bad)" }}>
                        {feedback.correct ? "Correct" : "Not quite"}
                      </p>
                      {!feedback.correct && <p>Model answer: {feedback.correctAnswer}</p>}
                      {feedback.explanation && <p style={{ color: "var(--muted)" }}>{feedback.explanation}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!result ? (
            <button className="btn btn-primary mt-4" disabled={submitting} onClick={submitQuiz}>
              {submitting ? "Grading…" : "Submit quiz"}
            </button>
          ) : (
            <p className="mt-4 font-semibold">
              Score: {Math.round(result.score * 100)}% — review scheduled via spaced repetition.
            </p>
          )}
        </div>
      )}

      {lesson.masteryCriteria && (
        <p className="mt-4 text-sm" style={{ color: "var(--muted)" }}>
          <span className="font-semibold">Mastery criteria:</span> {lesson.masteryCriteria}
        </p>
      )}

      {!lesson.completedAt && (
        <button
          className="btn btn-primary mt-4"
          onClick={async () => {
            await apiPost(`/api/lessons/${id}/complete`);
            await queryClient.invalidateQueries({ queryKey: ["lesson", id] });
          }}
        >
          Mark lesson complete
        </button>
      )}
    </div>
  );
}
