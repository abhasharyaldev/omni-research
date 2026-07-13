"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

const STAGES = [
  "understanding-request",
  "building-plan",
  "generating-subquestions",
  "discovering-sources",
  "scoring-candidates",
  "queuing-pages",
  "crawling",
  "extracting-content",
  "deduplicating",
  "classifying-sources",
  "extracting-evidence",
  "comparing-claims",
  "identifying-gaps",
  "following-up",
  "reconciling-disagreements",
  "writing-report",
  "verifying-citations",
  "complete",
] as const;

type LogEntry = { stage: string; message: string; at: string };
type RunState = {
  status: string;
  stage: string;
  counters: Record<string, number> | null;
  error: string | null;
  provider: string | null;
  startedAt: string | null;
};

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RunState | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ["run", id],
    queryFn: () => apiGet<{ run: any }>(`/api/research-runs/${id}`),
    refetchInterval: state && ["completed", "failed", "cancelled", "paused"].includes(state.status) ? false : 5000,
  });
  const run = data?.run;

  // Live progress over SSE — every event reflects real persisted backend state.
  useEffect(() => {
    const source = new EventSource(`/api/research-runs/${id}/events`);
    source.addEventListener("state", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as RunState;
      setState(next);
      if (["completed", "failed", "cancelled", "paused"].includes(next.status)) {
        source.close();
        void queryClient.invalidateQueries({ queryKey: ["run", id] });
      }
    });
    source.addEventListener("log", (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as LogEntry;
      setLog((prev) => [...prev.slice(-300), entry]);
    });
    source.onerror = () => {
      /* EventSource auto-reconnects; terminal states close it above */
    };
    return () => source.close();
  }, [id, queryClient]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (state?.startedAt && !["completed", "failed", "cancelled", "paused"].includes(state.status)) {
        setElapsed(Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [state]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const status = state?.status ?? run?.status ?? "queued";
  const stage = state?.stage ?? run?.stage ?? "understanding-request";
  const counters = state?.counters ?? run?.countersJson ?? {};
  const stageIndex = STAGES.indexOf(stage as (typeof STAGES)[number]);
  const terminal = ["completed", "failed", "cancelled", "paused"].includes(status);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Research run</h1>
        <span className={`badge ${status === "completed" ? "badge-good" : status === "failed" ? "badge-bad" : "badge-accent"}`}>{status}</span>
        {state?.provider && <span className="badge">provider: {state.provider}</span>}
        {!terminal && <span className="badge">{Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed</span>}
        <div className="ml-auto flex gap-2">
          {run && <Link href={`/projects/${run.projectId}`} className="btn">Project</Link>}
          {status === "completed" && run && <Link href={`/projects/${run.projectId}/report`} className="btn btn-primary">Open report</Link>}
          {!terminal && (
            <>
              <button className="btn" onClick={() => apiPost(`/api/research-runs/${id}/pause`)}>Pause</button>
              <button className="btn btn-danger" onClick={() => apiPost(`/api/research-runs/${id}/cancel`)}>Cancel</button>
            </>
          )}
          {(status === "paused" || status === "cancelled" || status === "failed") && (
            <button className="btn btn-primary" onClick={() => apiPost(`/api/research-runs/${id}/resume`)}>
              {status === "paused" ? "Resume" : "Retry"}
            </button>
          )}
        </div>
      </div>

      {state?.error && (
        <div className="panel mt-4 border p-4 text-sm" style={{ borderColor: "var(--bad)", color: "var(--bad)" }}>
          {state.error}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="panel p-5 lg:col-span-1">
          <h2 className="mb-3 font-semibold">Pipeline stages</h2>
          <ol className="space-y-1 text-sm">
            {STAGES.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background:
                      i < stageIndex || status === "completed"
                        ? "var(--good)"
                        : i === stageIndex && !terminal
                          ? "var(--accent)"
                          : "var(--line)",
                  }}
                />
                <span style={{ color: i <= stageIndex ? "var(--ink)" : "var(--muted)" }}>
                  {s.replace(/-/g, " ")}
                  {i === stageIndex && !terminal && " …"}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {[
              ["discovered", counters.pagesDiscovered],
              ["queued", counters.pagesQueued],
              ["completed", counters.pagesCompleted],
              ["skipped", counters.pagesSkipped],
              ["failed", counters.pagesFailed],
              ["sources", counters.sourcesAccepted],
              ["duplicates", counters.sourcesRejected],
              ["evidence", counters.evidenceRecords],
              ["citations", counters.citations],
            ].map(([label, value]) => (
              <div key={label as string} className="panel p-3 text-center">
                <p className="text-xl font-bold">{(value as number) ?? 0}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>{label}</p>
              </div>
            ))}
          </div>

          <div className="panel p-4">
            <h2 className="mb-2 font-semibold">Research log</h2>
            <div ref={logRef} className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
              {log.length === 0 && <p style={{ color: "var(--muted)" }}>Waiting for events…</p>}
              {log.map((entry, i) => (
                <p key={i}>
                  <span style={{ color: "var(--muted)" }}>{new Date(entry.at).toLocaleTimeString()} </span>
                  <span style={{ color: "var(--accent)" }}>[{entry.stage}]</span> {entry.message}
                </p>
              ))}
            </div>
          </div>

          {run?.crawlRequests?.length > 0 && (
            <div className="panel p-4">
              <h2 className="mb-2 font-semibold">Pages ({run.crawlRequests.length})</h2>
              <div className="max-h-72 overflow-y-auto text-xs">
                <table className="w-full text-left">
                  <thead>
                    <tr style={{ color: "var(--muted)" }}>
                      <th className="py-1 pr-2">Status</th>
                      <th className="py-1 pr-2">URL</th>
                      <th className="py-1">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.crawlRequests.map((cr: any) => (
                      <tr key={cr.id} className="border-t align-top" style={{ borderColor: "var(--line)" }}>
                        <td className="py-1 pr-2">
                          <span className={`badge ${cr.status === "retrieved" ? "badge-good" : cr.status === "failed" ? "badge-bad" : cr.status === "skipped" ? "badge-warn" : ""}`}>
                            {cr.status}
                          </span>
                        </td>
                        <td className="max-w-xs truncate py-1 pr-2">{cr.url}</td>
                        <td className="py-1" style={{ color: "var(--muted)" }}>{cr.skipReason ?? cr.failureReason ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
