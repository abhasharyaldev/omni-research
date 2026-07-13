"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiDelete, apiGet, apiPost, ApiError } from "@/lib/api";
import { RunPreviewDialog } from "@/components/run-preview";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [subquestionDraft, setSubquestionDraft] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: () => apiGet<{ project: any }>(`/api/projects/${id}`),
    refetchInterval: 4000,
  });
  const project = data?.project;
  const latestRun = project?.runs?.[0];
  const plan = latestRun?.planJson;

  const startRun = useMutation({
    mutationFn: () =>
      apiPost(`/api/projects/${id}/research-runs`, {
        planOverrides: subquestionDraft
          ? { subquestions: subquestionDraft.split("\n").map((s) => s.trim()).filter(Boolean) }
          : undefined,
      }),
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["project", id] });
      router.push(`/runs/${result.run.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not start run"),
  });

  const createLearningPlan = useMutation({
    mutationFn: () =>
      apiPost("/api/learning-plans", {
        projectId: id,
        subject: project.title,
        kind: project.mode === "learn-skill" ? "practical-skill" : "school-subject",
        currentLevel: project.gradeLevel || "beginner",
        targetLevel: "proficient",
        hoursPerWeek: 5,
      }),
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["project", id] });
      router.push(`/learning/${result.planId}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not create learning plan"),
  });

  if (isLoading || !project) return <div className="skeleton mt-8 h-48" />;

  const isLearning = project.mode === "learn-subject" || project.mode === "learn-skill";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">{project.title}</h1>
        <span className="badge badge-accent">{project.mode}</span>
        <div className="ml-auto flex gap-2">
          <Link href={`/projects/${id}/sources`} className="btn">Source library ({project._count.sources})</Link>
          <Link href={`/projects/${id}/story`} className="btn">Story studio</Link>
          {project.reports?.length > 0 && <Link href={`/projects/${id}/report`} className="btn">Report</Link>}
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!confirm("Delete this project and all of its data?")) return;
              await apiDelete(`/api/projects/${id}`);
              router.push("/dashboard");
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <p className="mt-3 max-w-3xl text-sm" style={{ color: "var(--muted)" }}>{project.prompt}</p>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Research plan</h2>
            {latestRun && (
              <span className={`badge ${latestRun.status === "completed" ? "badge-good" : latestRun.status === "failed" ? "badge-bad" : "badge-accent"}`}>
                last run: {latestRun.status}
              </span>
            )}
          </div>
          {plan ? (
            <div className="mt-3 space-y-3 text-sm">
              <p><span className="font-semibold">Main question:</span> {plan.mainQuestion}</p>
              <div>
                <p className="label">Subquestions (editable — one per line)</p>
                <textarea
                  className="textarea"
                  rows={Math.min(8, (plan.subquestions?.length ?? 3) + 1)}
                  value={subquestionDraft ?? (plan.subquestions ?? []).join("\n")}
                  onChange={(e) => setSubquestionDraft(e.target.value)}
                />
              </div>
              {plan.discoveryQueries?.length > 0 && (
                <p style={{ color: "var(--muted)" }}>Discovery queries: {plan.discoveryQueries.join(" · ")}</p>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm" style={{ color: "var(--muted)" }}>
              The plan is generated when the first run starts and shown here for editing afterwards.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={["queued", "running"].includes(latestRun?.status)}
              onClick={() => setPreviewOpen(true)}
            >
              {["queued", "running"].includes(latestRun?.status) ? "Run in progress…" : "Preview & start run"}
            </button>
            <button
              className="btn"
              title="Start immediately with automatic source selection (no preview)"
              disabled={startRun.isPending || ["queued", "running"].includes(latestRun?.status)}
              onClick={() => startRun.mutate()}
            >
              Quick start
            </button>
            {latestRun && ["queued", "running", "paused"].includes(latestRun.status) && (
              <Link href={`/runs/${latestRun.id}`} className="btn">View live progress</Link>
            )}
          </div>
          {previewOpen && <RunPreviewDialog projectId={id} onClose={() => setPreviewOpen(false)} />}
          {error && <p className="mt-2 text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
        </div>

        <div className="space-y-4">
          {isLearning && (
            <div className="panel p-5">
              <h2 className="font-semibold">Learning plan</h2>
              {project.learningPlans?.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {project.learningPlans.map((p: any) => (
                    <Link key={p.id} href={`/learning/${p.id}`} className="block text-sm underline" style={{ color: "var(--accent)" }}>
                      {p.subject} ({p.kind}) — {p.status}
                    </Link>
                  ))}
                </div>
              ) : (
                <>
                  <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
                    Build a personalized curriculum with units, lessons, quizzes, and spaced review.
                  </p>
                  <button className="btn btn-primary mt-3" disabled={createLearningPlan.isPending} onClick={() => createLearningPlan.mutate()}>
                    {createLearningPlan.isPending ? "Building…" : "Build learning plan"}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="panel p-5">
            <h2 className="font-semibold">Run history</h2>
            <div className="mt-3 space-y-2 text-sm">
              {(project.runs ?? []).length === 0 && <p style={{ color: "var(--muted)" }}>No runs yet.</p>}
              {(project.runs ?? []).map((run: any) => (
                <Link key={run.id} href={`/runs/${run.id}`} className="flex items-center gap-2 hover:underline">
                  <span className={`badge ${run.status === "completed" ? "badge-good" : run.status === "failed" ? "badge-bad" : ""}`}>{run.status}</span>
                  <span style={{ color: "var(--muted)" }}>{new Date(run.createdAt).toLocaleString()}</span>
                  <span className="truncate">{run.stage}</span>
                </Link>
              ))}
            </div>
          </div>

          <div className="panel p-5 text-sm">
            <h2 className="font-semibold">Watchlist</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
              Monitor this project and get a suggested refresh cadence. Refreshing reuses the normal
              research-run flow — no background jobs.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(project.watched)}
                  onChange={async (e) => {
                    await apiPost(`/api/projects/${id}/watch`, { watched: e.target.checked, cadence: project.watchCadence ?? "manual" });
                    await queryClient.invalidateQueries({ queryKey: ["project", id] });
                  }}
                />
                monitored
              </label>
              <select
                className="select w-auto"
                value={project.watchCadence ?? "manual"}
                aria-label="Refresh cadence"
                onChange={async (e) => {
                  await apiPost(`/api/projects/${id}/watch`, { watched: true, cadence: e.target.value });
                  await queryClient.invalidateQueries({ queryKey: ["project", id] });
                }}
              >
                {["manual", "daily", "weekly", "monthly"].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {project.nextCheckAt && (
                <span className="badge">next check {new Date(project.nextCheckAt).toLocaleDateString()}</span>
              )}
              {project.lastCheckedAt && (
                <span className="badge" style={{ color: "var(--muted)" }}>last checked {new Date(project.lastCheckedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>

          <div className="panel p-5 text-sm">
            <h2 className="font-semibold">Settings snapshot</h2>
            <dl className="mt-2 grid grid-cols-2 gap-1" style={{ color: "var(--muted)" }}>
              <dt>Citation style</dt><dd>{project.citationStyle}</dd>
              <dt>Max sources</dt><dd>{project.maxSources ?? "default"}</dd>
              <dt>Provider</dt><dd>{project.provider ?? "default"}</dd>
              <dt>Starting URLs</dt><dd>{(project.startingUrls ?? []).length}</dd>
              <dt>Evidence records</dt><dd>{project._count.evidence}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
