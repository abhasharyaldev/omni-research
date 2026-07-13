"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

const STATUS_BADGE: Record<string, string> = {
  ready: "badge-good",
  installed: "badge-accent",
  "authentication-required": "badge-warn",
  "usage-limit-reached": "badge-warn",
  "unsupported-plan": "badge-warn",
  misconfigured: "badge-bad",
  "not-installed": "",
};

const SETUP_HINTS: Record<string, string> = {
  "codex-cli": "Install the official OpenAI Codex CLI, then run `codex login` and sign in with your ChatGPT account. Not every plan includes Codex CLI access.",
  "claude-code": "Install Claude Code (https://claude.com/claude-code), run `claude` once, and log in with your Claude account. Plan limits apply.",
  "gemini-cli": "Install the official Gemini CLI, run `gemini` once, and sign in with your Google account.",
  ollama: "Install Ollama from https://ollama.com, run `ollama serve`, and pull a model, e.g. `ollama pull llama3.1`.",
  mock: "Built in — deterministic outputs for demos and tests. No login, no network, and no real synthesis quality.",
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: any[]; defaultProvider: string }>("/api/providers"),
  });

  const check = useMutation({
    mutationFn: (id: string) => apiPost(`/api/providers/${id}/check`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const setDefault = useMutation({
    mutationFn: (id: string) => apiPost(`/api/providers/${id}/set-default`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });

  const test = async (id: string) => {
    setTestResult((r) => ({ ...r, [id]: "testing…" }));
    try {
      const { result } = await apiPost<{ result: { ok: boolean; detail: string } }>(`/api/providers/${id}/test`);
      setTestResult((r) => ({ ...r, [id]: `${result.ok ? "OK" : "Failed"}: ${result.detail}` }));
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
    } catch (err) {
      setTestResult((r) => ({ ...r, [id]: `Failed: ${(err as Error).message}` }));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="pt-2 text-2xl font-bold">Settings</h1>

      <h2 className="mt-6 text-lg font-bold">AI providers</h2>
      <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
        OmniResearch uses locally installed, officially authenticated AI tools. It never asks for
        passwords or browser cookies, never forwards API-key environment variables, and never
        switches to pay-as-you-go billing. “Test connection” sends one tiny request and may count
        against your plan usage.
      </p>

      {isLoading && <div className="skeleton mt-4 h-40" />}
      <div className="mt-4 space-y-3">
        {(data?.providers ?? []).map((provider) => (
          <div key={provider.id} className="panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{provider.displayName}</span>
              <span className={`badge ${STATUS_BADGE[provider.statusCode] ?? ""}`}>{provider.statusCode}</span>
              {provider.version && <span className="badge">{provider.version}</span>}
              {data?.defaultProvider === provider.id && <span className="badge badge-accent">default</span>}
              <div className="ml-auto flex gap-2">
                <button className="btn" disabled={check.isPending} onClick={() => check.mutate(provider.id)}>
                  Check
                </button>
                <button className="btn" onClick={() => test(provider.id)}>Test connection</button>
                {data?.defaultProvider !== provider.id && (
                  <button className="btn" onClick={() => setDefault.mutate(provider.id)}>Set default</button>
                )}
              </div>
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              {provider.detail}
            </p>
            {testResult[provider.id] && (
              <p className="mt-1 text-xs font-semibold" style={{ color: testResult[provider.id].startsWith("OK") ? "var(--good)" : "var(--warn)" }}>
                {testResult[provider.id]}
              </p>
            )}
            <details className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              <summary className="cursor-pointer font-semibold">Setup instructions</summary>
              <p className="mt-1">{SETUP_HINTS[provider.id]}</p>
              {provider.capabilities?.notes && (
                <ul className="mt-1 list-disc pl-5">
                  {provider.capabilities.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}
                </ul>
              )}
            </details>
            {provider.lastCheckedAt && (
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Last checked {new Date(provider.lastCheckedAt).toLocaleString()}
              </p>
            )}
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-bold">Data & privacy</h2>
      <div className="panel mt-3 space-y-2 p-4 text-sm" style={{ color: "var(--muted)" }}>
        <p>• Everything is stored locally in your PostgreSQL database (or the embedded fallback under <code>.local-data/</code>).</p>
        <p>• Stored source content is trimmed after the retention window (default 30 days, configurable via <code>SOURCE_CONTENT_RETENTION_DAYS</code>); source metadata and citation locators are kept so reports stay auditable.</p>
        <p>• Full source text storage is controlled by <code>STORE_FULL_SOURCE_CONTENT</code> — off by default (excerpts only after retention).</p>
        <p>• Delete a project (project page) to remove all of its sources, evidence, and reports. Delete your account from the API (<code>DELETE /api/auth/account</code>) to remove everything.</p>
        <p>• Crawl defaults live in <code>.env</code> (<code>CRAWLER_*</code>); values are clamped to hard ceilings server-side.</p>
      </div>

      <h2 className="mt-8 text-lg font-bold">Crawlee</h2>
      <div className="panel mt-3 p-4 text-sm" style={{ color: "var(--muted)" }}>
        <p>
          The crawler is the official Apify Crawlee framework, cloned from
          {" "}<code>https://github.com/apify/crawlee</code> and pinned to a verified release. Run
          {" "}<code>pnpm verify:crawlee</code> to re-check the origin, pinned commit, and a local fixture crawl;
          see <code>vendor/crawlee-version.json</code> for the exact tag and commit.
        </p>
      </div>
    </div>
  );
}
