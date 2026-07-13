"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export default function DashboardPage() {
  const { data: me, isLoading: meLoading } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiGet<{ user: { displayName: string } | null }>("/api/auth/me"),
    retry: false,
  });
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: any[] }>("/api/projects"),
    enabled: Boolean(me?.user),
    refetchInterval: 5000,
  });
  const { data: providers } = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: any[]; defaultProvider: string }>("/api/providers"),
    enabled: Boolean(me?.user),
  });

  if (meLoading) return <div className="skeleton mt-8 h-40" />;
  if (!me?.user) {
    return (
      <div className="mx-auto max-w-md pt-16 text-center">
        <h1 className="text-xl font-bold">Sign in to see your dashboard</h1>
        <Link href="/login" className="btn btn-primary mt-4">Sign in</Link>
      </div>
    );
  }

  const projects = data?.projects ?? [];
  const activeRuns = projects.filter((p) => ["queued", "running"].includes(p.runs?.[0]?.status));
  const readyProviders = providers?.providers.filter((p) => p.statusCode === "ready") ?? [];

  return (
    <div>
      <div className="flex items-center justify-between pt-2">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link href="/projects/new" className="btn btn-primary">New project</Link>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="panel p-4">
          <p className="label">Active runs</p>
          <p className="text-3xl font-bold">{activeRuns.length}</p>
          {activeRuns.map((p) => (
            <Link key={p.id} href={`/runs/${p.runs[0].id}`} className="mt-1 block text-sm underline" style={{ color: "var(--accent)" }}>
              {p.title} — {p.runs[0].status}
            </Link>
          ))}
        </div>
        <div className="panel p-4">
          <p className="label">Projects</p>
          <p className="text-3xl font-bold">{projects.length}</p>
        </div>
        <div className="panel p-4">
          <p className="label">Provider readiness</p>
          <p className="text-3xl font-bold">{readyProviders.length || "—"}</p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Default: {providers?.defaultProvider ?? "mock"} · <Link href="/settings" className="underline">manage</Link>
          </p>
        </div>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
        Projects
      </h2>
      {isLoading && <div className="skeleton h-32" />}
      {projects.length === 0 && !isLoading && (
        <div className="panel p-8 text-center text-sm" style={{ color: "var(--muted)" }}>
          No projects yet. Start one from the <Link href="/" className="underline">home page</Link> or with the
          seed demo (<code>pnpm db:seed</code>).
        </div>
      )}
      <div className="grid gap-2">
        {projects.map((project) => (
          <Link key={project.id} href={`/projects/${project.id}`} className="panel flex flex-wrap items-center gap-3 px-4 py-3 hover:opacity-80">
            <span className="font-semibold">{project.title}</span>
            <span className="badge">{project.mode}</span>
            {project.runs?.[0] && (
              <span className={`badge ${project.runs[0].status === "completed" ? "badge-good" : project.runs[0].status === "failed" ? "badge-bad" : "badge-accent"}`}>
                {project.runs[0].status}
              </span>
            )}
            <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
              {project._count.sources} sources · {project._count.reports} reports
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
