"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost, ApiError } from "@/lib/api";

const MODES = [
  "auto", "documentary", "investigative", "historical-narrative", "mystery", "rise-and-fall",
  "discovery-story", "invention-story", "case-study", "news-explainer", "educational-story",
  "problem-and-solution", "transformation", "timeline", "conflict-and-resolution",
  "myth-versus-reality", "human-interest", "technical-breakdown", "fast-short-form", "calm-long-form",
];
const PLATFORMS = ["youtube-long", "youtube-short", "tiktok", "reels", "podcast", "generic"];
const WORKFLOW = ["Research", "Verify", "Blueprint", "Outline", "Script", "Validate"] as const;
const STAGES = ["blueprint", "outline", "hooks", "scenes", "script", "critique"] as const;

const LINE_BADGE: Record<string, string> = {
  supported: "badge-good",
  inferred: "badge-warn",
  disputed: "badge-bad",
  opinion: "badge-warn",
  unsupported: "badge-bad",
  "non-factual": "",
};

function reviewSuggestion(issue: any): string {
  if (issue.code === "disputed-stated-as-fact") {
    if (/black dahlia|press/i.test(issue.text ?? "")) {
      return "Rewrite as: FBI material ties the Black Dahlia nickname to press accounts, but the exact origin should be treated carefully.";
    }
    if (/fbi vault|archival/i.test(issue.text ?? "")) {
      return "Rewrite as: FBI Vault materials appear to include Black Dahlia-related records, but the FBI file is not a complete case record because LAPD had jurisdiction.";
    }
    return "Rewrite this as disputed or uncertain, not as a flat fact.";
  }
  if (issue.code === "missing-citation") return "Add a valid E-ref or remove the factual claim.";
  if (issue.code === "unknown-evidence-ref") return "Replace the invented or invalid E-ref with one that exists in the research package.";
  if (issue.code === "altered-number") return "Copy the number exactly from the cited evidence, or remove the number.";
  return "Revise the line so it is directly supported by cited evidence, or remove it.";
}

export default function StoryStudioPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyStage, setBusyStage] = useState<string | null>(null);
  const [mode, setMode] = useState("auto");
  const [platform, setPlatform] = useState("youtube-long");
  const [duration, setDuration] = useState(480);
  const [tone, setTone] = useState("clear and engaging");
  const [audience, setAudience] = useState("general audience");
  const [evidenceRefOpen, setEvidenceRefOpen] = useState<string | null>(null);

  const { data: skillStatus } = useQuery({
    queryKey: ["storytelling-status"],
    queryFn: () => apiGet<any>("/api/storytelling/status"),
  });
  const { data: storiesData } = useQuery({
    queryKey: ["stories", id],
    queryFn: () => apiGet<{ stories: any[] }>(`/api/projects/${id}/stories`),
  });
  const activeStoryId = storiesData?.stories?.[0]?.id;
  const { data: storyData } = useQuery({
    queryKey: ["story", activeStoryId],
    queryFn: () => apiGet<{ story: any }>(`/api/stories/${activeStoryId}`),
    enabled: Boolean(activeStoryId),
  });
  const { data: pkgData } = useQuery({
    queryKey: ["story-package", activeStoryId],
    queryFn: () => apiGet<{ package: any }>(`/api/stories/${activeStoryId}/package`),
    enabled: Boolean(activeStoryId),
  });

  const story = storyData?.story;
  const artifacts = story?.artifacts ?? {};
  const pendingInvocation = story?.invocations?.find((invocation: any) => invocation.status === "pending");
  const critiqueMissingDraft = /no draft script|draft script (?:was )?not provided|missing draft/i.test(artifacts.critique?.overallAssessment ?? "");
  const effectiveCritique = critiqueMissingDraft && artifacts.validation
    ? {
        overallAssessment: `Generated from validation because the saved critique did not attach to the draft. ${artifacts.validation.summary}`,
        findings: (artifacts.validation.issues ?? []).map((issue: any) => ({
          category: issue.code,
          offendingLine: issue.text,
          lineIndex: issue.lineIndex,
          problem: issue.detail,
          suggestedRevision: reviewSuggestion(issue),
        })),
      }
    : artifacts.critique;
  const pkg = pkgData?.package;
  const evidenceByRef: Record<string, any> = {};
  for (const e of pkg?.evidence ?? []) evidenceByRef[e.ref] = e;
  const lockedRefs = new Set((story?.lockedFacts ?? []).map((l: any) => l.evidenceRef));

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["story", activeStoryId] }),
    queryClient.invalidateQueries({ queryKey: ["stories", id] }),
  ]);

  useEffect(() => {
    if (storyData) setError(null);
  }, [storyData]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusyStage(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String((err as Error).message));
    } finally {
      setBusyStage(null);
    }
  };

  const createStory = () =>
    run("create", () =>
      apiPost(`/api/projects/${id}/stories`, {
        settings: { mode, platform, targetDurationSec: duration, tone, audience },
      })
    );

  const workflowStep = !story
    ? 1
    : artifacts.validation
      ? 6
      : artifacts.script
        ? 5
        : artifacts.outline
          ? 4
          : artifacts.blueprint
            ? 3
            : 2;

  const EvidenceRefChips = ({ refs }: { refs?: string[] }) => (
    <>
      {(refs ?? []).map((ref) => (
        <button key={ref} className="citation-marker mx-0.5" title={evidenceByRef[ref]?.claim ?? ref} onClick={() => setEvidenceRefOpen(ref)}>
          [{ref}]
        </button>
      ))}
    </>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <h1 className="text-2xl font-bold">Story studio</h1>
        {story && <span className={`badge ${story.status === "validated" ? "badge-good" : story.status === "needs-review" ? "badge-warn" : "badge-accent"}`}>{story.status}</span>}
        <Link href={`/projects/${id}`} className="btn ml-auto">Project</Link>
        <Link href={`/projects/${id}/report`} className="btn">Report</Link>
      </div>

      {/* Honest skill status — never claims the skill unless detected. */}
      <div className="panel mt-3 flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
        {skillStatus?.integration === "claude-skill" ? (
          <>
            <span className="badge badge-good">storytelling skill detected</span>
            <span style={{ color: "var(--muted)" }}>
              {skillStatus.storytelling.path} · sha256 {skillStatus.storytelling.hash?.slice(0, 12)}… · loaded fresh on every generation
            </span>
            {skillStatus.viralHooks && <span className="badge badge-accent">viral-hooks companion detected</span>}
          </>
        ) : (
          <>
            <span className="badge badge-warn">skill not found — using OmniResearch fallback</span>
            <span style={{ color: "var(--muted)" }}>
              searched: {(skillStatus?.searchedPaths ?? []).join(" · ")}
            </span>
          </>
        )}
      </div>

      {/* Workflow stepper */}
      <div className="mt-4 flex flex-wrap items-center gap-1 text-xs">
        {WORKFLOW.map((step, index) => (
          <span key={step} className="flex items-center gap-1">
            <span
              className="badge"
              style={index + 1 <= workflowStep ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
            >
              {index + 1}. {step}
            </span>
            {index < WORKFLOW.length - 1 && <span style={{ color: "var(--muted)" }}>→</span>}
          </span>
        ))}
      </div>

      {error && <div className="panel mt-3 border p-3 text-sm" style={{ borderColor: "var(--bad)", color: "var(--bad)" }}>{error}</div>}
      {pendingInvocation && !busyStage && (
        <div className="panel mt-3 border p-3 text-sm" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>
          Generating {pendingInvocation.stage}. If this was interrupted, retry after the stale timeout and OmniResearch will mark the old attempt failed automatically.
        </div>
      )}

      {!story && (
        <div className="panel mt-4 space-y-4 p-5">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Storytelling transforms this project&apos;s <strong>verified research</strong> into an engaging script. It
            never replaces evidence collection or fact-checking — every factual line stays linked to its evidence.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label">Storytelling mode</label>
              <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
                {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Platform</label>
              <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Target duration (seconds)</label>
              <input type="number" min={15} max={3600} className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))} />
            </div>
            <div>
              <label className="label">Tone</label>
              <input className="input" value={tone} onChange={(e) => setTone(e.target.value)} />
            </div>
            <div>
              <label className="label">Audience</label>
              <input className="input" value={audience} onChange={(e) => setAudience(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-primary" disabled={busyStage !== null} onClick={createStory}>
            {busyStage === "create" ? "Creating…" : "Create story from verified research"}
          </button>
        </div>
      )}

      {story && (
        <>
          <div className="panel mt-4 flex flex-wrap items-center gap-2 p-4 text-sm">
            <span className="badge badge-accent">{story.resolvedMode}</span>
            <span className="badge">{story.framework}</span>
            <span className="badge">{story.platform} · {story.targetDurationSec}s</span>
            {story.providerUsed && <span className="badge">provider: {story.providerUsed}</span>}
            <p className="w-full text-xs" style={{ color: "var(--muted)" }}>
              <strong>Why this structure:</strong> {story.frameworkReason}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {STAGES.map((stage) => (
              <button
                key={stage}
                className={`btn ${!artifacts[stage] && (stage === "blueprint" || artifacts.blueprint) ? "btn-primary" : ""}`}
                disabled={busyStage !== null || Boolean(pendingInvocation)}
                onClick={() => run(stage, () => apiPost(`/api/stories/${story.id}/generate/${stage}`))}
              >
                {busyStage === stage ? `Generating ${stage}…` : `${artifacts[stage] ? "Regenerate" : "Generate"} ${stage}`}
              </button>
            ))}
            <button
              className="btn btn-primary"
              disabled={busyStage !== null || Boolean(pendingInvocation) || !artifacts.script}
              onClick={() => run("validate", () => apiPost(`/api/stories/${story.id}/validate`))}
            >
              {busyStage === "validate" ? "Validating…" : "Validate script"}
            </button>
          </div>

          {artifacts.blueprint && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">Blueprint <span className="badge ml-1">v{story.artifactVersions.blueprint}</span></h2>
              <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                {[
                  ["Central question", artifacts.blueprint.centralQuestion],
                  ["Viewer promise", artifacts.blueprint.viewerPromise],
                  ["Main subject", artifacts.blueprint.mainSubject],
                  ["Main conflict", artifacts.blueprint.mainConflict],
                  ["Story lens", artifacts.blueprint.storyLens],
                  ["Final takeaway", artifacts.blueprint.finalTakeaway],
                  ["Remaining uncertainty", artifacts.blueprint.remainingUncertainty],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k as string}><dt className="label">{k}</dt><dd>{v as string}</dd></div>
                ))}
              </dl>
              <div className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                Key discoveries:{" "}
                {(artifacts.blueprint.keyDiscoveries ?? []).map((d: any, i: number) => (
                  <span key={i}>{d.text} <EvidenceRefChips refs={d.evidenceRefs} /> · </span>
                ))}
              </div>
            </div>
          )}

          {artifacts.hooks && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">Hooks <span className="badge ml-1">v{story.artifactVersions.hooks}</span></h2>
              {(artifacts.hooks.hooks ?? []).map((hook: any, i: number) => (
                <div key={i} className="mt-2 border-t pt-2" style={{ borderColor: "var(--line)" }}>
                  <p className="font-semibold">“{hook.text}” <EvidenceRefChips refs={hook.evidenceRefs} /></p>
                  <p className="text-xs" style={{ color: "var(--muted)" }}>
                    {hook.type} · emotion: {hook.intendedEmotion} · exaggeration risk:{" "}
                    <span className={`badge ${hook.exaggerationRisk === "none" || hook.exaggerationRisk === "low" ? "badge-good" : "badge-warn"}`}>{hook.exaggerationRisk}</span>
                    {hook.saferAlternative && <> · safer: “{hook.saferAlternative}”</>}
                  </p>
                </div>
              ))}
              {(artifacts.hooks.rejected ?? []).length > 0 && (
                <p className="mt-2 text-xs" style={{ color: "var(--warn)" }}>
                  {artifacts.hooks.rejected.length} hook(s) rejected by the safety gate:{" "}
                  {artifacts.hooks.rejected.map((r: any) => `“${r.text.slice(0, 60)}” (${r.reason})`).join(" · ")}
                </p>
              )}
            </div>
          )}

          {artifacts.outline && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">Outline <span className="badge ml-1">v{story.artifactVersions.outline}</span></h2>
              {(artifacts.outline.sections ?? []).map((section: any, i: number) => (
                <div key={i} className="mt-2">
                  <p className="font-semibold">{section.title} <span className="text-xs" style={{ color: "var(--muted)" }}>~{section.estimatedSeconds}s</span></p>
                  <ul className="ml-4 list-disc text-xs">
                    {section.beats.map((beat: any, j: number) => (
                      <li key={j}>
                        {beat.connector !== "opening" && <strong className="uppercase">{beat.connector} </strong>}
                        {beat.text} <EvidenceRefChips refs={beat.evidenceRefs} />
                        {beat.kind !== "fact" && <span className="badge badge-warn ml-1">{beat.kind}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {artifacts.script && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">
                Script: {artifacts.script.title} <span className="badge ml-1">v{story.artifactVersions.script}</span>
                <span className="badge ml-1">~{artifacts.script.estimatedSeconds}s · {artifacts.script.estimatedWords} words</span>
              </h2>
              <div className="mt-2 space-y-1">
                {(artifacts.script.lines ?? []).map((line: any, i: number) => {
                  const status = artifacts.validation?.lineStatuses?.find((s: any) => s.lineIndex === i)?.status;
                  return (
                    <p key={i} className="flex items-start gap-2">
                      <span className="badge shrink-0">{line.kind}</span>
                      <span className="flex-1">
                        {line.text} <EvidenceRefChips refs={line.evidenceRefs} />
                        {(line.evidenceRefs ?? []).some((r: string) => lockedRefs.has(r)) && <span className="badge badge-accent ml-1">locked</span>}
                      </span>
                      {status && <span className={`badge shrink-0 ${LINE_BADGE[status] ?? ""}`}>{status}</span>}
                    </p>
                  );
                })}
              </div>
            </div>
          )}

          {effectiveCritique && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">Critique <span className="badge ml-1">v{story.artifactVersions.critique}</span></h2>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{effectiveCritique.overallAssessment}</p>
              {(effectiveCritique.findings ?? []).map((f: any, i: number) => (
                <p key={i} className="mt-2 text-xs">
                  <span className="badge badge-warn">{f.category}</span>{" "}
                  {typeof f.lineIndex === "number" && <span className="badge">line {f.lineIndex}</span>} {f.problem}
                  {f.offendingLine && <em className="block" style={{ color: "var(--muted)" }}>“{f.offendingLine}”</em>}
                  {f.suggestedRevision && <span className="block">→ {f.suggestedRevision}</span>}
                </p>
              ))}
            </div>
          )}

          {artifacts.validation && (
            <div className="panel mt-4 p-5 text-sm" style={{ borderColor: artifacts.validation.verdict === "ready" ? "var(--good)" : "var(--warn)" }}>
              <h2 className="font-bold">
                Validation:{" "}
                <span className={`badge ${artifacts.validation.verdict === "ready" ? "badge-good" : "badge-warn"}`}>{artifacts.validation.verdict}</span>
              </h2>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>{artifacts.validation.summary}</p>
              {(artifacts.validation.issues ?? []).length > 0 && (
                <div className="mt-3 border-t pt-2 text-xs" style={{ borderColor: "var(--line)" }}>
                  <p className="font-semibold">Suggested fixes</p>
                  {(artifacts.validation.issues ?? []).map((issue: any, i: number) => (
                    <p key={`fix-${i}`} className="mt-2">
                      <span className="badge">{typeof issue.lineIndex === "number" ? `line ${issue.lineIndex}` : "script"}</span>{" "}
                      <span style={{ color: "var(--accent)" }}>{reviewSuggestion(issue)}</span>
                    </p>
                  ))}
                </div>
              )}
              {(artifacts.validation.issues ?? []).map((issue: any, i: number) => (
                <p key={i} className="mt-1 text-xs">
                  <span className={`badge ${issue.severity === "high" ? "badge-bad" : "badge-warn"}`}>{issue.code}</span>{" "}
                  {issue.detail} <em style={{ color: "var(--muted)" }}>“{issue.text.slice(0, 120)}”</em>
                </p>
              ))}
            </div>
          )}

          {pkg && (
            <div className="panel mt-4 p-5 text-sm">
              <h2 className="font-bold">Research package v{pkg.packageVersion} <span className="badge ml-1">{pkg.evidence.length} evidence</span></h2>
              <p className="text-xs" style={{ color: "var(--muted)" }}>Lock a fact to protect it from rewrites; locked facts trigger a validation failure if dropped.</p>
              <div className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs">
                {pkg.evidence.map((e: any) => (
                  <p key={e.ref} className="flex items-start gap-2">
                    <button className="citation-marker shrink-0" onClick={() => setEvidenceRefOpen(e.ref)}>[{e.ref}]</button>
                    <span className="flex-1">{e.claim}</span>
                    <button
                      className="btn shrink-0 px-2 py-0.5"
                      onClick={() =>
                        run("lock", () =>
                          lockedRefs.has(e.ref)
                            ? fetch(`/api/stories/${story.id}/lock-fact/${e.ref}`, { method: "DELETE", headers: { "x-omni-csrf": "1" } })
                            : apiPost(`/api/stories/${story.id}/lock-fact`, { evidenceRef: e.ref })
                        )
                      }
                    >
                      {lockedRefs.has(e.ref) ? "🔒 unlock" : "lock"}
                    </button>
                  </p>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {evidenceRefOpen && evidenceByRef[evidenceRefOpen] && (
        <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l p-5 shadow-2xl" style={{ background: "var(--panel)", borderColor: "var(--line)" }}>
          <div className="flex items-center justify-between">
            <h3 className="font-bold">Evidence {evidenceRefOpen}</h3>
            <button className="btn" onClick={() => setEvidenceRefOpen(null)}>Close</button>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <p className="font-semibold">{evidenceByRef[evidenceRefOpen].claim}</p>
            <blockquote className="border-l-2 pl-3" style={{ borderColor: "var(--accent)" }}>
              “{evidenceByRef[evidenceRefOpen].excerpt}”
            </blockquote>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {evidenceByRef[evidenceRefOpen].sourceTitle} · quality {evidenceByRef[evidenceRefOpen].qualityScore}/100 ·{" "}
              {evidenceByRef[evidenceRefOpen].classification}
              {evidenceByRef[evidenceRefOpen].citationMarker && <> · report citation [{evidenceByRef[evidenceRefOpen].citationMarker}]</>}
            </p>
            <a className="btn" href={evidenceByRef[evidenceRefOpen].sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
              Open source ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
