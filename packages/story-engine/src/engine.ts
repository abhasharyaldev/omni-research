import { newId, type ProviderId } from "@omni/shared";
import { fenceExcerpts } from "@omni/security";
import type { PrismaClient } from "@omni/database";
import type { AiTaskKind, ProviderManager, StructuredSchema } from "@omni/ai-providers";
import { detectStorytellingSkills, type DetectedSkill, type SkillDetectionReport } from "./skill-detection.js";
import { buildResearchPackage, renderPackageForPrompt } from "./research-package.js";
import {
  BLUEPRINT_SCHEMA_DESCRIPTION,
  CRITIQUE_SCHEMA_DESCRIPTION,
  HOOKS_SCHEMA_DESCRIPTION,
  OUTLINE_SCHEMA_DESCRIPTION,
  SCENES_SCHEMA_DESCRIPTION,
  SCRIPT_SCHEMA_DESCRIPTION,
  autoSelectMode,
  blueprintSchema,
  critiqueSchema,
  hooksSchema,
  outlineSchema,
  scenesSchema,
  scriptSchema,
  type StorySettings,
} from "./schemas.js";
import { validateScript, vetHooks, type ScriptValidation } from "./validation.js";

export type StoryStage = "blueprint" | "outline" | "hooks" | "scenes" | "script" | "critique";

const STAGE_TASK: Record<StoryStage, AiTaskKind> = {
  blueprint: "story-blueprint",
  outline: "story-outline",
  hooks: "story-hooks",
  scenes: "story-scenes",
  script: "story-script",
  critique: "story-critique",
};

function staleStoryInvocationCutoff(): Date {
  const timeoutMs = Number(process.env.AI_PROCESS_TIMEOUT_MS || 180_000);
  const staleAfterMs = Number(process.env.STALE_STORY_INVOCATION_AFTER_MS || Math.max(timeoutMs + 30_000, 240_000));
  return new Date(Date.now() - staleAfterMs);
}

/**
 * OmniResearch's own structured story-planning instructions — the documented
 * FALLBACK used when the installed storytelling skill is not available. It is
 * deliberately conservative and never claims to be the Claude skill.
 */
const FALLBACK_CRAFT_INSTRUCTIONS = `STORY-PLANNING FALLBACK (OmniResearch built-in — the installed storytelling skill was NOT found):
- Alternate context and complication; connect beats with BUT or THEREFORE, never "and then".
- Decide the ending first; make the final line memorable and true.
- Vary sentence lengths; write one spoken sentence per line.
- Plain, conversational tone — as if explaining to one person.
- Never invent facts, numbers, quotes, motives, or biography. Structure is your job; the truth comes only from the research package.`;

function skillInstructionBlock(skill: DetectedSkill | null, companion: DetectedSkill | null, stage: StoryStage): { text: string; method: string } {
  if (!skill) return { text: FALLBACK_CRAFT_INSTRUCTIONS, method: "fallback-instructions" };
  const parts = [
    `INSTALLED STORYTELLING SKILL — "${skill.name}" (${skill.filePath}, sha256 ${skill.contentHash.slice(0, 12)}…).`,
    "Follow these skill instructions exactly as written:",
    "----- BEGIN SKILL INSTRUCTIONS -----",
    skill.instructions,
    "----- END SKILL INSTRUCTIONS -----",
  ];
  if (stage === "hooks" && companion) {
    parts.push(
      `COMPANION SKILL — "${companion.name}" (the storytelling skill delegates hooks to it):`,
      "----- BEGIN COMPANION SKILL -----",
      companion.instructions,
      "----- END COMPANION SKILL -----"
    );
  }
  parts.push(
    "OVERRIDING CONSTRAINT (OmniResearch): the skill's craft applies ONLY to structure, pacing, tone, and framing. Every factual statement must come from the fenced RESEARCH PACKAGE and cite its E-refs. The skill's own rule agrees: never fabricate."
  );
  return { text: parts.join("\n"), method: "embedded-skill-instructions" };
}

export class StorytellingEngine {
  constructor(
    private prisma: PrismaClient,
    private providers: ProviderManager
  ) {}

  /** Availability report: what is actually installed, right now. */
  status(): SkillDetectionReport & { integration: "claude-skill" | "fallback" } {
    const report = detectStorytellingSkills();
    return { ...report, integration: report.storytelling ? "claude-skill" : "fallback" };
  }

  async createStory(projectId: string, title: string, settings: StorySettings): Promise<string> {
    const pkg = await buildResearchPackage(this.prisma, projectId);
    if (pkg.evidence.length === 0) {
      throw new Error(
        "This project has no verified evidence yet. Run research first — storytelling only transforms verified research; it never replaces it."
      );
    }
    const auto = autoSelectMode({
      prompt: pkg.prompt,
      disputedCount: pkg.disputedClaims.length,
      eventDates: pkg.eventDatesCount,
      peopleMentioned: pkg.peopleMentioned,
      platform: settings.platform,
      targetDurationSec: settings.targetDurationSec,
    });
    const resolvedMode = settings.mode === "auto" ? auto.mode : settings.mode;
    const story = await this.prisma.story.create({
      data: {
        id: newId("sty"),
        projectId,
        title: title.slice(0, 290),
        mode: settings.mode,
        resolvedMode,
        framework: auto.framework,
        frameworkReason:
          settings.mode === "auto"
            ? auto.reason
            : `User selected the "${settings.mode}" mode; the framework may be refined by the blueprint stage.`,
        platform: settings.platform,
        targetDurationSec: settings.targetDurationSec,
        settingsJson: settings as object,
        packageVersion: pkg.packageVersion,
      },
    });
    return story.id;
  }

  /** Run one storytelling stage; records the invocation and stores a version. */
  async generate(storyId: string, stage: StoryStage): Promise<{ version: number; content: unknown; invocation: { method: string; skillId?: string } }> {
    const story = await this.prisma.story.findUniqueOrThrow({ where: { id: storyId }, include: { project: true } });
    const settings = (story.settingsJson ?? {}) as StorySettings;
    const pkg = await buildResearchPackage(this.prisma, story.projectId);
    const providerId = (story.project.provider ?? this.providers.defaultId()) as ProviderId;
    const provider = this.providers.get(providerId);

    // Detect the skill FRESH each invocation and record exactly what ran.
    const skills = detectStorytellingSkills();
    const { text: craft, method } = skillInstructionBlock(skills.storytelling, skills.viralHooks, stage);
    const effectiveMethod = providerId === "mock" ? "mock" : method;
    const staleCutoff = staleStoryInvocationCutoff();

    await this.prisma.storyInvocation.updateMany({
      where: { storyId, status: "pending", createdAt: { lt: staleCutoff } },
      data: {
        status: "failed",
        error: "Marked failed because the previous story generation request stopped before completing. You can retry safely.",
      },
    });

    const pending = await this.prisma.storyInvocation.findFirst({
      where: { storyId, status: "pending", createdAt: { gte: staleCutoff } },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      throw new Error(`Storytelling stage "${pending.stage}" is already running. Wait for it to finish, or retry after the stale timeout.`);
    }

    const priorScript = stage === "critique" ? await this.latest(storyId, "script") : null;
    const sourceExcerpts = [
      {
        sourceId: "research-package",
        title: `Research package v${pkg.packageVersion}`,
        url: "",
        text: renderPackageForPrompt(pkg),
        instructionPolicy: "data-only" as const,
      },
    ];
    const parsedPriorScript = stage === "critique" && priorScript ? scriptSchema.parse(priorScript.contentJson) : null;
    const draftScriptForCritique = parsedPriorScript
      ? parsedPriorScript.lines.map((line, index) => `[${index}] ${line.text}`).join("\n")
      : "";
    if (stage === "critique" && priorScript && parsedPriorScript) {
      sourceExcerpts.push({
        sourceId: "draft-script",
        title: `Draft script v${priorScript.version}`,
        url: "",
        text: draftScriptForCritique,
        instructionPolicy: "data-only",
      });
    }
    const fenced = fenceExcerpts(sourceExcerpts, `story-${storyId}`);

    const instructions = [
      `You are the storytelling stage "${stage}" of a research-to-video pipeline.`,
      `Story mode: ${story.resolvedMode}. Framework: ${story.framework}. Platform: ${story.platform}. Target duration: ${story.targetDurationSec}s (≈${story.targetDurationSec * 2} spoken words).`,
      `Audience: ${settings.audience ?? "general"}. Tone: ${settings.tone ?? "clear"}. Pace: ${settings.pace ?? "moderate"}. Suspense: ${settings.suspense ?? "medium"}. Technical depth: ${settings.technicalDepth ?? "beginner"}. Narration: ${settings.narration ?? "third-person"} (${settings.delivery ?? "conversational"}).`,
      craft,
      draftScriptForCritique ? `DRAFT SCRIPT TO AUDIT (trusted app-generated lines; quote exact line text and line index in critique findings):\n${draftScriptForCritique}` : "",
      "HARD RULES: use only facts from the fenced research package; cite evidence refs (E1, E2…) on every factual element; preserve the distinction between fact, reported claim, interpretation, inference, speculation, and unknown; present DISPUTED claims as disputed or omit them; respect the PROHIBITED list. Do not invent citations.",
      stage === "critique" ? "Critique the DRAFT SCRIPT source block against the skill's audit checklist. Quote offending lines exactly and include their line indexes." : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const schemas: Record<StoryStage, { schema: StructuredSchema<any>; description: string }> = {
      blueprint: { schema: blueprintSchema, description: BLUEPRINT_SCHEMA_DESCRIPTION },
      outline: { schema: outlineSchema, description: OUTLINE_SCHEMA_DESCRIPTION },
      hooks: { schema: hooksSchema, description: HOOKS_SCHEMA_DESCRIPTION },
      scenes: { schema: scenesSchema, description: SCENES_SCHEMA_DESCRIPTION },
      script: { schema: scriptSchema, description: SCRIPT_SCHEMA_DESCRIPTION },
      critique: { schema: critiqueSchema, description: CRITIQUE_SCHEMA_DESCRIPTION },
    };

    const started = Date.now();
    const invocation = await this.prisma.storyInvocation.create({
      data: {
        id: newId("sin"),
        storyId,
        stage,
        providerId,
        skillId: skills.storytelling?.id,
        skillHash: skills.storytelling?.contentHash,
        method: effectiveMethod,
        status: "pending",
        durationMs: 0,
        packageVersion: pkg.packageVersion,
      },
    });
    let content: unknown;
    try {
      content = await provider.generateStructured(
        {
          requestId: `story-${storyId}-${stage}-${Date.now()}`,
          taskKind: STAGE_TASK[stage],
          instructions,
          data: fenced.text,
          context: {
            projectTitle: pkg.projectTitle,
            evidence: pkg.evidence.map((e) => ({ ref: e.ref, claim: e.claim, excerpt: e.excerpt.slice(0, 300), sourceTitle: e.sourceTitle })),
            settings,
            framework: story.framework,
            stage,
            script: priorScript?.contentJson ?? undefined,
          },
          schemaDescription: schemas[stage].description,
        },
        schemas[stage].schema
      );
    } catch (err) {
      await this.prisma.storyInvocation.update({
        where: { id: invocation.id },
        data: {
          status: "failed",
          error: String((err as Error).message).slice(0, 900),
          durationMs: Date.now() - started,
        },
      });
      // NEVER silently fall back — surface the failure with options.
      throw new Error(
        `Storytelling stage "${stage}" failed on provider "${providerId}": ${(err as Error).message}. ` +
          "You can retry, switch the project's provider, or the UI's fallback mode (no provider switch happens automatically)."
      );
    }

    // Deterministic post-gates that no provider output can bypass.
    if (stage === "hooks") {
      const vetted = vetHooks(pkg, content as any);
      content = { hooks: vetted.accepted, rejected: vetted.rejected.map((r) => ({ text: r.hook.text, reason: r.reason })) };
    }
    if (stage === "critique" && parsedPriorScript) {
      const critique = content as { overallAssessment?: string; findings?: unknown[] };
      if (/no draft script|draft script (?:was )?not provided|missing draft/i.test(critique.overallAssessment ?? "")) {
        const validation = validateScript(pkg, parsedPriorScript);
        content = {
          findings: validation.issues.slice(0, 20).map((issue) => ({
            category: "unsupported-drama",
            offendingLine: issue.text,
            lineIndex: issue.lineIndex,
            problem: issue.detail,
            suggestedRevision:
              issue.code === "disputed-stated-as-fact"
                ? "Rewrite this as disputed or uncertain, preserving the evidence reference and avoiding a flat factual claim."
                : "Revise this line so the wording is directly supported by the cited evidence, or remove it.",
          })),
          overallAssessment:
            `Provider critique did not attach to the draft, so OmniResearch generated this deterministic review from validation. ${validation.summary}`,
        };
      }
    }

    await this.prisma.storyInvocation.update({
      where: { id: invocation.id },
      data: {
        status: "success",
        durationMs: Date.now() - started,
      },
    });

    const latest = await this.latest(storyId, stage);
    const version = (latest?.version ?? 0) + 1;
    await this.prisma.storyVersion.create({
      data: { id: newId("sv"), storyId, kind: stage, version, contentJson: content as object },
    });
    await this.prisma.story.update({
      where: { id: storyId },
      data: {
        status: "in-progress",
        providerUsed: providerId,
        skillId: skills.storytelling?.id ?? null,
        skillHash: skills.storytelling?.contentHash ?? null,
        packageVersion: pkg.packageVersion,
        ...(stage === "blueprint"
          ? {
              framework: (content as any).framework ?? story.framework,
              frameworkReason: (content as any).frameworkReason ?? story.frameworkReason,
            }
          : {}),
      },
    });
    return { version, content, invocation: { method: effectiveMethod, skillId: skills.storytelling?.id } };
  }

  /** Mandatory validation over the latest script; stores the result and gates status. */
  async validate(storyId: string): Promise<ScriptValidation> {
    const story = await this.prisma.story.findUniqueOrThrow({ where: { id: storyId } });
    const scriptVersion = await this.latest(storyId, "script");
    if (!scriptVersion) throw new Error("No script has been generated yet — generate the script stage first.");
    const pkg = await buildResearchPackage(this.prisma, story.projectId);
    const locked = await this.prisma.storyLockedFact.findMany({ where: { storyId } });
    const parsed = scriptSchema.parse(scriptVersion.contentJson);
    const result = validateScript(pkg, parsed, locked.map((l) => ({ evidenceRef: l.evidenceRef, text: l.text })));

    const latest = await this.latest(storyId, "validation");
    await this.prisma.storyVersion.create({
      data: { id: newId("sv"), storyId, kind: "validation", version: (latest?.version ?? 0) + 1, contentJson: result as object },
    });
    await this.prisma.story.update({
      where: { id: storyId },
      data: { status: result.verdict === "ready" ? "validated" : "needs-review" },
    });
    return result;
  }

  private latest(storyId: string, kind: string) {
    return this.prisma.storyVersion.findFirst({
      where: { storyId, kind },
      orderBy: { version: "desc" },
    });
  }
}
