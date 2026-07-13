"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet } from "@/lib/api";

const EXAMPLES = [
  { mode: "learn-subject", text: "Teach me Algebra 2 from the beginning." },
  { mode: "deep-research", text: "Research the causes and consequences of the Industrial Revolution." },
  { mode: "news-catchup", text: "Catch me up on artificial-intelligence news from the past seven days." },
  { mode: "deep-research", text: "Compare nuclear, solar, wind, and hydroelectric power." },
  { mode: "learn-skill", text: "Build me a 30-day TypeScript learning plan." },
  { mode: "fact-check", text: "Check whether this claim is supported by evidence." },
];

const MODES = [
  { id: "deep-research", label: "Deep research" },
  { id: "learn-subject", label: "Learn a subject" },
  { id: "learn-skill", label: "Learn a skill" },
  { id: "news-catchup", label: "News catch-up" },
  { id: "fact-check", label: "Compare & fact-check" },
  { id: "school-project", label: "School project" },
];

export default function LandingPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("deep-research");

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiGet<{ user: unknown | null }>("/api/auth/me"),
    retry: false,
  });
  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiGet<{ projects: any[] }>("/api/projects"),
    enabled: Boolean(me?.user),
    retry: false,
  });

  const start = () => {
    const params = new URLSearchParams({ prompt, mode });
    router.push(me?.user ? `/projects/new?${params}` : `/register?next=${encodeURIComponent(`/projects/new?${params}`)}`);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <section className="pt-10 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">
          Research anything. <span style={{ color: "var(--accent)" }}>Verify everything.</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm" style={{ color: "var(--muted)" }}>
          OmniResearch crawls permitted public sources with Crawlee, connects every claim to stored
          evidence, and teaches you subjects and skills — locally, with your own AI subscriptions or
          fully offline in mock mode. No paid API keys required.
        </p>
      </section>

      <section className="panel mt-8 p-4">
        <textarea
          className="textarea"
          rows={3}
          placeholder="What do you want to research or learn?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className="badge"
              style={mode === m.id ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
          <button className="btn btn-primary ml-auto" disabled={!prompt.trim()} onClick={start}>
            Start →
          </button>
        </div>
      </section>

      <section className="mt-6 grid gap-2 sm:grid-cols-2">
        {EXAMPLES.map((example) => (
          <button
            key={example.text}
            type="button"
            className="panel px-4 py-3 text-left text-sm transition hover:opacity-80"
            onClick={() => {
              setPrompt(example.text);
              setMode(example.mode);
            }}
          >
            “{example.text}”
          </button>
        ))}
      </section>

      {projectsData?.projects && projectsData.projects.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
            Recent projects
          </h2>
          <div className="grid gap-2">
            {projectsData.projects.slice(0, 5).map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`} className="panel flex items-center gap-3 px-4 py-3 hover:opacity-80">
                <span className="font-semibold">{project.title}</span>
                <span className="badge">{project.mode}</span>
                <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>
                  {project._count.sources} sources
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
