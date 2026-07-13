"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export default function LearningPlanPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ["learning-plan", id],
    queryFn: () => apiGet<{ plan: any }>(`/api/learning-plans/${id}`),
  });
  const plan = data?.plan;

  if (isLoading || !plan) return <div className="skeleton mt-8 h-48" />;

  const lessons = plan.units.flatMap((u: any) => u.lessons);
  const completed = lessons.filter((l: any) => l.completedAt).length;
  const dueReviews = plan.reviews.filter((r: any) => new Date(r.dueAt) <= new Date());

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">{plan.subject}</h1>
        <span className="badge badge-accent">{plan.kind}</span>
        <span className="badge">{plan.currentLevel} → {plan.targetLevel}</span>
        <Link href={`/projects/${plan.project.id}`} className="btn ml-auto">Project</Link>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div className="panel p-4">
          <p className="label">Progress</p>
          <p className="text-3xl font-bold">{completed}/{lessons.length}</p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>lessons completed</p>
          <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
            <div className="h-full rounded-full" style={{ width: `${lessons.length ? (completed / lessons.length) * 100 : 0}%`, background: "var(--accent)" }} />
          </div>
        </div>
        <div className="panel p-4">
          <p className="label">Reviews due</p>
          <p className="text-3xl font-bold">{dueReviews.length}</p>
          <ul className="mt-1 space-y-1 text-xs" style={{ color: "var(--muted)" }}>
            {dueReviews.slice(0, 4).map((r: any) => <li key={r.id}>{r.conceptKey}</li>)}
          </ul>
        </div>
        <div className="panel p-4">
          <p className="label">Weak concepts</p>
          {plan.mastery.filter((m: any) => m.mastery < 0.6).slice(0, 5).map((m: any) => (
            <div key={m.id} className="mt-1 flex items-center gap-2 text-xs">
              <span className="flex-1 truncate">{m.conceptKey}</span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                <div className="h-full" style={{ width: `${m.mastery * 100}%`, background: m.mastery < 0.4 ? "var(--bad)" : "var(--warn)" }} />
              </div>
            </div>
          ))}
          {plan.mastery.length === 0 && <p className="text-xs" style={{ color: "var(--muted)" }}>Take quizzes to build mastery data.</p>}
        </div>
      </div>

      <div className="mt-6 space-y-4">
        {plan.units.map((unit: any, ui: number) => (
          <div key={unit.id} className="panel p-5">
            <h2 className="font-bold">Unit {ui + 1}: {unit.title}</h2>
            {unit.summary && <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>{unit.summary}</p>}
            <ol className="mt-3 space-y-1">
              {unit.lessons.map((lesson: any, li: number) => (
                <li key={lesson.id} className="flex items-center gap-2 text-sm">
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      background: lesson.completedAt ? "var(--good)" : "var(--line)",
                      color: lesson.completedAt ? "white" : "var(--muted)",
                    }}
                  >
                    {lesson.completedAt ? "✓" : li + 1}
                  </span>
                  <Link href={`/lessons/${lesson.id}`} className="hover:underline">{lesson.title}</Link>
                  <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                    ~{lesson.estimatedMinutes} min{lesson.hasContent ? "" : " · generates on open"}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}

        {plan.skillProjects.length > 0 && (
          <div className="panel p-5">
            <h2 className="font-bold">Milestone projects</h2>
            <div className="mt-3 space-y-3">
              {plan.skillProjects.map((project: any) => (
                <div key={project.id} className="text-sm">
                  <p className="font-semibold">
                    {project.title} {project.milestone && <span className="badge badge-accent ml-1">capstone</span>}
                  </p>
                  <p style={{ color: "var(--muted)" }}>{project.brief}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
