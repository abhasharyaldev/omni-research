"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { apiPost, ApiError } from "@/lib/api";

const MODES = [
  { id: "deep-research", label: "Deep research" },
  { id: "learn-subject", label: "Learn a subject" },
  { id: "learn-skill", label: "Learn a skill" },
  { id: "news-catchup", label: "News catch-up" },
  { id: "fact-check", label: "Compare & fact-check" },
  { id: "school-project", label: "School project" },
];

function NewProjectForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState(search.get("prompt") ?? "");
  const [mode, setMode] = useState(search.get("mode") ?? "deep-research");
  const [topics, setTopics] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [maxSources, setMaxSources] = useState(15);
  const [citationStyle, setCitationStyle] = useState("web");
  const [startingUrls, setStartingUrls] = useState("");
  const [excludeDomains, setExcludeDomains] = useState("");
  const [includeDomains, setIncludeDomains] = useState("");
  const [provider, setProvider] = useState("");
  const [maxDepth, setMaxDepth] = useState(1);
  const [maxPagesPerDomain, setMaxPagesPerDomain] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const topicList = topics
        .split(/[\n,]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const { project } = await apiPost<{ project: { id: string } }>("/api/projects", {
        title: title.trim() || prompt.slice(0, 80),
        mode,
        prompt,
        topics: topicList.length > 0 ? topicList : [title.trim() || prompt.slice(0, 80)],
        gradeLevel: gradeLevel || undefined,
        maxSources,
        citationStyle,
        startingUrls: startingUrls.split(/\s+/).map((u) => u.trim()).filter(Boolean),
        includeDomains: includeDomains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
        excludeDomains: excludeDomains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
        provider: provider || undefined,
        crawlLimits: { maxDepth, maxPagesPerDomain },
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create project");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 pt-2 text-2xl font-bold">New project</h1>
      <form className="space-y-5" onSubmit={submit}>
        <div className="panel space-y-4 p-5">
          <div>
            <label className="label">Research or learning request</label>
            <textarea className="textarea" rows={3} required value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Research the causes and consequences of the Industrial Revolution" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Title (optional)</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </div>
            <div>
              <label className="label">Mode</label>
              <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Topics (comma or newline separated, optional)</label>
            <textarea className="textarea" rows={2} value={topics} onChange={(e) => setTopics(e.target.value)}
              placeholder="e.g. steam power, urbanization, labor conditions" />
          </div>
        </div>

        <div className="panel space-y-4 p-5">
          <p className="font-semibold">Sources & discovery</p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            OmniResearch discovers sources from the URLs, RSS feeds, and sitemaps you provide, plus links
            found on those pages. It does not scrape search engines, so give it at least one starting point.
          </p>
          <div>
            <label className="label">Starting URLs / feeds / sitemaps (one per line)</label>
            <textarea className="textarea" rows={3} value={startingUrls} onChange={(e) => setStartingUrls(e.target.value)}
              placeholder={"https://example.org/article\nhttps://example.org/feed.xml"} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Only these domains (optional)</label>
              <input className="input" value={includeDomains} onChange={(e) => setIncludeDomains(e.target.value)} placeholder="example.org, *.edu" />
            </div>
            <div>
              <label className="label">Exclude domains (optional)</label>
              <input className="input" value={excludeDomains} onChange={(e) => setExcludeDomains(e.target.value)} placeholder="pinterest.com" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Max sources</label>
              <input type="number" min={1} max={100} className="input" value={maxSources} onChange={(e) => setMaxSources(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Crawl depth (0–4)</label>
              <input type="number" min={0} max={4} className="input" value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Pages per domain</label>
              <input type="number" min={1} max={40} className="input" value={maxPagesPerDomain} onChange={(e) => setMaxPagesPerDomain(Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="panel space-y-4 p-5">
          <p className="font-semibold">Output & provider</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label">Grade level (optional)</label>
              <input className="input" value={gradeLevel} onChange={(e) => setGradeLevel(e.target.value)} placeholder="9th grade" />
            </div>
            <div>
              <label className="label">Citation style</label>
              <select className="select" value={citationStyle} onChange={(e) => setCitationStyle(e.target.value)}>
                <option value="web">Simple web</option>
                <option value="apa">APA</option>
                <option value="mla">MLA</option>
                <option value="chicago">Chicago</option>
              </select>
            </div>
            <div>
              <label className="label">AI provider</label>
              <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Default</option>
                <option value="mock">Mock (offline)</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex-cli">Codex CLI</option>
                <option value="gemini-cli">Gemini CLI</option>
                <option value="ollama">Ollama</option>
              </select>
            </div>
          </div>
        </div>

        {error && <p className="text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
        <button className="btn btn-primary" disabled={busy || !prompt.trim()}>
          {busy ? "Creating…" : "Create project"}
        </button>
      </form>
    </div>
  );
}

export default function NewProjectPage() {
  return (
    <Suspense>
      <NewProjectForm />
    </Suspense>
  );
}
