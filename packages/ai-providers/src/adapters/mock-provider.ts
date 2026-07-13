import { detectBillingSensitiveVars } from "@omni/security";
import type {
  GenerateStructuredRequest,
  GenerateTextRequest,
  GenerateTextResult,
  ProviderAuthenticationStatus,
  ProviderCapabilities,
  ProviderInstallationStatus,
  StructuredSchema,
  SubscriptionAIProvider,
} from "../provider-types.js";
import { ProviderError } from "../provider-types.js";

/**
 * Deterministic mock provider: no model, no login, no network. It derives
 * outputs from the structured context the engines supply (e.g. it selects
 * real sentences from crawled sources as evidence), so the full pipeline —
 * including citation verification against stored source text — works honestly
 * without any AI subscription. It never claims real synthesis quality: every
 * synthesized report carries a mock-mode notice.
 */
export class MockProvider implements SubscriptionAIProvider {
  id = "mock" as const;
  displayName = "Built-in mock provider";

  async checkInstallation(): Promise<ProviderInstallationStatus> {
    return { installed: true, version: "built-in", detail: "No installation required" };
  }

  async checkAuthentication(): Promise<ProviderAuthenticationStatus> {
    return {
      authenticated: true,
      method: "none",
      detail: "The mock provider requires no account",
      billingWarnings: detectBillingSensitiveVars().map(
        (v) => `${v} is set in your environment; it is never forwarded to providers`
      ),
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      textGeneration: true,
      structuredOutput: "native",
      streaming: false,
      localOnly: true,
      notes: [
        "Deterministic outputs for demos and automated tests",
        "Does not provide real research-synthesis quality",
      ],
    };
  }

  async cancel(): Promise<void> {
    /* synchronous provider; nothing to cancel */
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    const started = Date.now();
    const value = this.produce(request);
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { text, provider: this.id, model: "mock-deterministic", durationMs: Date.now() - started };
  }

  async generateStructured<T>(request: GenerateStructuredRequest, schema: StructuredSchema<T>): Promise<T> {
    const value = this.produce(request);
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ProviderError(
        "invalid-output",
        `Mock provider produced output that failed schema validation for task "${request.taskKind}": ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        this.id
      );
    }
    return result.data;
  }

  // ---- deterministic task implementations --------------------------------

  private produce(request: GenerateTextRequest): unknown {
    const ctx = request.context ?? {};
    switch (request.taskKind) {
      case "research-plan":
        return this.researchPlan(ctx);
      case "evidence-extraction":
        return this.evidenceExtraction(ctx);
      case "synthesis":
      case "section-deepen":
        return this.synthesis(ctx);
      case "lesson-generation":
        return this.lesson(ctx);
      case "skill-plan":
        return this.skillPlan(ctx);
      case "news-summaries":
        return this.newsSummaries(ctx);
      case "fact-check":
        return this.factCheck(ctx);
      case "quiz-feedback":
        return this.quizFeedback(ctx);
      case "gap-analysis":
        return this.gapAnalysis(ctx);
      case "reconciliation":
        return this.reconciliation(ctx);
      case "story-blueprint":
      case "story-outline":
      case "story-hooks":
      case "story-scenes":
      case "story-script":
      case "story-critique":
        return this.story(request.taskKind, ctx);
      case "generic":
      default:
        return `Mock provider response for: ${request.instructions.slice(0, 160)}`;
    }
  }

  private terms(text: string): string[] {
    return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3))];
  }

  private researchPlan(ctx: Record<string, unknown>): unknown {
    const prompt = String(ctx.prompt ?? "the requested topic");
    const topics = Array.isArray(ctx.topics) && ctx.topics.length > 0 ? ctx.topics.map(String) : [prompt.slice(0, 80)];
    const subquestions = topics.flatMap((topic) => [
      `What is ${topic}, and what background is needed to understand it?`,
      `What does the available evidence say about ${topic}?`,
      `Where do sources disagree about ${topic}, and what remains uncertain?`,
    ]);
    return {
      mainQuestion: prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt,
      subquestions: subquestions.slice(0, 9),
      keyTerms: topics.flatMap((t) => this.terms(t)).slice(0, 12),
      discoveryQueries: topics.flatMap((t) => [`${t} overview`, `${t} evidence`, `${t} analysis`]).slice(0, 9),
      sourceCategories: ["educational-reference", "government", "journalism", "peer-reviewed"],
      outline: [
        "Executive summary",
        ...topics.map((t) => `Findings: ${t}`),
        "Conflicting perspectives",
        "Limitations",
        "Conclusion",
      ],
    };
  }

  private evidenceExtraction(ctx: Record<string, unknown>): unknown {
    const query = String(ctx.query ?? "");
    const queryTerms = this.terms(query);
    const subquestions = Array.isArray(ctx.subquestions) ? ctx.subquestions.map(String) : [];
    const sources = Array.isArray(ctx.sources) ? (ctx.sources as any[]) : [];
    const evidence: unknown[] = [];
    for (const source of sources) {
      const sentences: string[] = Array.isArray(source.sentences) ? source.sentences : [];
      const scored = sentences
        .filter((s) => s.trim().split(/\s+/).length >= 6)
        .map((sentence) => {
          const lower = sentence.toLowerCase();
          let score = 0;
          for (const term of queryTerms) if (lower.includes(term)) score++;
          return { sentence, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      scored.forEach(({ sentence, score }, index) => {
        const subquestionIndex = subquestions.length > 0 ? (evidence.length + index) % subquestions.length : undefined;
        evidence.push({
          sourceId: String(source.sourceId),
          claim: sentence.trim().slice(0, 300),
          evidenceText: sentence.trim(),
          subquestionIndex,
          relevanceScore: Math.min(1, 0.35 + score * 0.15),
          evidenceStrength: score >= 2 ? "moderate" : "weak",
          evidenceType: /\d/.test(sentence) ? "data" : "finding",
        });
      });
    }
    return { evidence };
  }

  private synthesis(ctx: Record<string, unknown>): unknown {
    const mainQuestion = String(ctx.mainQuestion ?? "Research question");
    const subquestions = Array.isArray(ctx.subquestions) ? ctx.subquestions.map(String) : [];
    const evidence = Array.isArray(ctx.evidence) ? (ctx.evidence as any[]) : [];
    const sections: { kind: string; title: string; contentMd: string }[] = [];

    const cite = (item: any) => `[${item.marker}]`;
    const summaryLines = evidence
      .slice(0, 6)
      .map((item) => `- ${String(item.claim).replace(/\.*$/, "")}.${cite(item)}`);
    sections.push({
      kind: "executive-summary",
      title: "Executive summary",
      contentMd:
        `**Research question:** ${mainQuestion}\n\n` +
        (summaryLines.length > 0
          ? `Key findings from the collected sources:\n\n${summaryLines.join("\n")}`
          : "No evidence records were collected, so no findings can be stated."),
    });

    subquestions.forEach((sq, index) => {
      const related = evidence.filter((item) => item.subquestionIndex === index);
      const body =
        related.length > 0
          ? related
              .map(
                (item) =>
                  `- ${String(item.claim).replace(/\.*$/, "")}.${cite(item)} *(source: ${item.sourceTitle ?? "untitled"})*`
              )
              .join("\n")
          : "_No direct evidence was collected for this subquestion. This is an evidence gap._";
      sections.push({ kind: "analysis", title: sq, contentMd: body });
    });

    sections.push({
      kind: "limitations",
      title: "Limitations",
      contentMd:
        "- This report was assembled by the deterministic mock provider, which selects sentences " +
        "from crawled sources; it does not perform real analytical synthesis.\n" +
        "- Discovery was limited to the URLs, feeds, and links configured for this run — the whole internet was NOT searched.\n" +
        "- Claims are supported only by the excerpts cited; absence of evidence is noted, not filled in.",
    });
    return { sections };
  }

  private lesson(ctx: Record<string, unknown>): unknown {
    const subject = String(ctx.subject ?? "the subject");
    const lessonTitle = String(ctx.lessonTitle ?? `Introduction to ${subject}`);
    const level = String(ctx.level ?? "beginner");
    return {
      objective: `Understand and apply the core idea of "${lessonTitle}" at a ${level} level.`,
      whyItMatters: `"${lessonTitle}" is a building block for later topics in ${subject}; later lessons assume it.`,
      contentMd: [
        `## Simple explanation\nAt its core, **${lessonTitle}** is one focused idea inside ${subject}. Start by reading the linked sources below, then work the examples.`,
        `## Detailed explanation\nWork through the concept step by step: define terms, connect them to what you already know, then test yourself with the practice below. (Generated by the mock provider — connect a real AI provider for a full adaptive lesson.)`,
        `## Worked example\n1. State the problem.\n2. Identify what is given and what is asked.\n3. Apply the rule for ${lessonTitle}.\n4. Check the result against intuition.`,
        `## Common mistakes\n- Skipping prerequisites.\n- Memorizing steps without understanding why they work.`,
        `## Real-world application\nLook for one everyday situation where ${lessonTitle} shows up and describe it in your own words.`,
      ].join("\n\n"),
      guidedPractice: [
        `Restate "${lessonTitle}" in your own words in two sentences.`,
        `Work one example from a linked source with the solution visible.`,
      ],
      independentPractice: [
        `Solve one new problem about ${lessonTitle} without looking at notes.`,
        `Explain the concept to someone else (or in writing) from memory.`,
      ],
      quiz: [
        {
          prompt: `In one sentence, what is the main idea of "${lessonTitle}"?`,
          kind: "short-answer",
          correctAnswer: `A concise statement of the core idea of ${lessonTitle}.`,
          explanation: "Any answer that captures the definition in the lesson counts as correct.",
        },
        {
          prompt: `Why does "${lessonTitle}" matter for later topics in ${subject}?`,
          kind: "short-answer",
          correctAnswer: "Because later topics build on it as a prerequisite.",
          explanation: "The lesson's 'why it matters' section explains the dependency.",
        },
      ],
      masteryCriteria: "You can define the concept, work one example unaided, and explain one application.",
      estimatedMinutes: 30,
    };
  }

  private skillPlan(ctx: Record<string, unknown>): unknown {
    const skill = String(ctx.subject ?? ctx.skill ?? "the skill");
    const weeks = Math.max(2, Math.min(12, Number(ctx.weeks ?? 4)));
    const units = Array.from({ length: weeks }, (_, i) => ({
      title:
        i === 0
          ? `Foundations of ${skill}`
          : i === weeks - 1
            ? `Capstone: demonstrate ${skill}`
            : `${skill}: core practice ${i}`,
      summary:
        i === weeks - 1
          ? `Plan, build, and present a capstone project that demonstrates ${skill}.`
          : `Focused practice on one layer of ${skill}, ending with something you build or demonstrate.`,
      lessons: [
        `Concepts and vocabulary (week ${i + 1})`,
        `Guided practice (week ${i + 1})`,
        `Mini-project (week ${i + 1})`,
      ],
      milestoneProject: {
        title: i === weeks - 1 ? `${skill} capstone project` : `Week ${i + 1} mini-project`,
        brief: `Produce a small, reviewable artifact that exercises what week ${i + 1} covered.`,
        milestone: i === weeks - 1,
      },
    }));
    return { units };
  }

  private newsSummaries(ctx: Record<string, unknown>): unknown {
    const clusters = Array.isArray(ctx.clusters) ? (ctx.clusters as any[]) : [];
    return {
      events: clusters.map((cluster) => {
        const first = (cluster.articles ?? [])[0] ?? {};
        return {
          clusterIndex: Number(cluster.index ?? 0),
          headline: String(cluster.headline ?? first.title ?? "Untitled development"),
          summaryMd: String(first.snippet ?? first.title ?? "No summary text available from sources."),
          whyItMatters:
            "Assess impact from the linked articles directly — mock mode does not editorialize.",
          whatChanged: "See the article list for how coverage evolved across dates.",
          confidence: (cluster.articles ?? []).length >= 3 ? "high" : (cluster.articles ?? []).length === 2 ? "medium" : "low",
        };
      }),
    };
  }

  private factCheck(ctx: Record<string, unknown>): unknown {
    const claims = Array.isArray(ctx.claims) ? (ctx.claims as any[]) : [];
    return {
      verdicts: claims.map((claim, index) => {
        const supports = Number(claim.supportingCount ?? 0);
        const opposes = Number(claim.opposingCount ?? 0);
        let status: string;
        if (supports === 0 && opposes === 0) status = "unable-to-verify";
        else if (supports > 0 && opposes > 0) status = "disputed";
        else if (supports >= 3) status = "well-supported";
        else if (supports === 2) status = "mostly-supported";
        else if (supports === 1) status = "weakly-supported";
        else status = "unsupported";
        return {
          claimIndex: index,
          status,
          explanation:
            `Based on collected evidence: ${supports} supporting and ${opposes} opposing excerpt(s). ` +
            "Statuses are derived mechanically in mock mode; connect a real provider for nuanced evaluation.",
        };
      }),
    };
  }

  private gapAnalysis(ctx: Record<string, unknown>): unknown {
    const subquestions = Array.isArray(ctx.subquestions) ? ctx.subquestions.map(String) : [];
    const counts = Array.isArray(ctx.evidenceCounts) ? (ctx.evidenceCounts as number[]) : [];
    const gaps = subquestions
      .map((text, index) => ({ text, index, count: counts[index] ?? 0 }))
      .filter((g) => g.count < 2);
    return {
      gaps: gaps.map((g) => ({
        subquestionIndex: g.index,
        reason: `Only ${g.count} evidence record(s) support this subquestion.`,
      })),
      followupQueries: gaps.slice(0, 4).map((g) => `${g.text.replace(/\?$/, "")} evidence`),
      coverageSufficient: gaps.length === 0,
      decisionNote:
        gaps.length === 0
          ? "Every subquestion has at least 2 supporting evidence records — coverage sufficient."
          : `${gaps.length} subquestion(s) lack evidence; proposing follow-up queries (mechanical gap check in mock mode).`,
    };
  }

  private reconciliation(ctx: Record<string, unknown>): unknown {
    const pairs = Array.isArray(ctx.pairs) ? (ctx.pairs as any[]) : [];
    return {
      disagreements: pairs.map((pair, index) => {
        const dateA = pair.a?.publishedAt ? new Date(pair.a.publishedAt) : null;
        const dateB = pair.b?.publishedAt ? new Date(pair.b.publishedAt) : null;
        const newerExists = dateA && dateB && Math.abs(dateA.getTime() - dateB.getTime()) > 90 * 86_400_000;
        return {
          pairIndex: index,
          topic: String(pair.a?.claim ?? "the disputed point").slice(0, 280),
          conflictPoint: `"${String(pair.a?.claim ?? "").slice(0, 180)}" vs "${String(pair.b?.claim ?? "").slice(0, 180)}"`,
          kind: "factual",
          resolution: newerExists ? "superseded-by-newer" : "unresolved",
          assessment: newerExists
            ? "The excerpts differ and were published far apart; the newer source may reflect updated information. Mock mode cannot evaluate content beyond dates — verify manually."
            : "The excerpts make opposing statements and the given material does not resolve which is correct. This disagreement is reported, not resolved.",
          confidenceNote: "Mechanical comparison by the mock provider; connect a real AI provider for substantive reconciliation.",
        };
      }),
    };
  }

  /**
   * Deterministic storytelling outputs assembled ONLY from the research
   * package in ctx (evidence refs are echoed, never invented). Used for
   * tests and offline demos of the story workflow.
   */
  private story(kind: string, ctx: Record<string, unknown>): unknown {
    const evidence = Array.isArray(ctx.evidence) ? (ctx.evidence as { ref: string; claim: string; excerpt: string; sourceTitle?: string }[]) : [];
    const settings = (ctx.settings ?? {}) as Record<string, unknown>;
    const framework = String(ctx.framework ?? "three-act");
    const topic = String(ctx.projectTitle ?? "the topic");
    const first = evidence[0];
    const refs = (n: number) => evidence.slice(0, n).map((e) => e.ref);

    if (kind === "story-blueprint") {
      return {
        framework,
        frameworkReason: `Mock provider echoes the pre-selected framework "${framework}"; connect a real provider for judgment-based structuring.`,
        centralQuestion: `What does the verified evidence show about ${topic}?`,
        viewerPromise: "A walk through what the collected sources actually establish — nothing beyond them.",
        mainSubject: topic,
        mainConflict: evidence.length > 1 ? `What the evidence establishes vs. what remains open about ${topic}` : `Understanding ${topic} from limited evidence`,
        stakes: "",
        setting: "",
        people: [],
        startingSituation: { text: first?.claim ?? "Evidence collection begins.", evidenceRefs: refs(1) },
        triggeringEvent: { text: evidence[1]?.claim ?? first?.claim ?? "The first finding.", evidenceRefs: refs(2).slice(-1) },
        escalation: evidence.slice(2, 4).map((e) => ({ text: e.claim, evidenceRefs: [e.ref] })),
        turningPoints: [],
        keyDiscoveries: evidence.slice(0, 3).map((e) => ({ text: e.claim, evidenceRefs: [e.ref] })),
        contradictions: [],
        climax: { text: evidence[Math.max(0, evidence.length - 1)]?.claim ?? "The strongest finding.", evidenceRefs: evidence.length ? [evidence[evidence.length - 1]!.ref] : [] },
        resolution: { text: "The evidence, taken together, answers the central question within its limits.", evidenceRefs: refs(2) },
        remainingUncertainty: "Anything outside the research package remains unknown.",
        mainLesson: "",
        finalTakeaway: first ? `${first.claim}` : "See the collected evidence.",
        callToAction: "",
        storyLens: "Evidence-first walkthrough (mock mode — no unique lens is generated).",
      };
    }
    if (kind === "story-outline") {
      return {
        sections: [
          {
            title: "Opening",
            purpose: "Set the question",
            beats: [{ text: `What do we actually know about ${topic}?`, connector: "opening", evidenceRefs: [], kind: "question" }],
            estimatedSeconds: 15,
          },
          {
            title: "What the evidence shows",
            purpose: "Present findings",
            beats: evidence.slice(0, 6).map((e, i) => ({
              text: e.claim,
              connector: i % 2 === 0 ? "therefore" : "but",
              evidenceRefs: [e.ref],
              kind: "fact",
            })),
            estimatedSeconds: 60,
          },
          {
            title: "Takeaway",
            purpose: "Close the loop",
            beats: [{ text: "The verified evidence supports these findings and nothing more.", connector: "therefore", evidenceRefs: refs(2), kind: "fact" }],
            estimatedSeconds: 15,
          },
        ],
        retentionPlan: [
          { technique: "open question", placement: "opening", payoffAt: "takeaway section", informationUsed: "central question" },
        ],
      };
    }
    if (kind === "story-hooks") {
      return {
        hooks: evidence.slice(0, 3).map((e, i) => ({
          text: e.claim,
          type: (["question", "contrast", "discovery"] as const)[i % 3],
          intendedEmotion: "curiosity",
          factualBasis: e.claim,
          evidenceRefs: [e.ref],
          audienceFit: "States a verified finding directly (mock mode).",
          exaggerationRisk: "none",
          saferAlternative: "",
        })),
      };
    }
    if (kind === "story-scenes") {
      return {
        scenes: evidence.slice(0, 6).map((e) => ({
          goal: `Convey: ${e.claim.slice(0, 120)}`,
          narration: e.claim,
          mainClaim: e.claim,
          evidenceRefs: [e.ref],
          visualSuggestion: "text animation of the key phrase over a neutral background",
          visualSourceNote: "generated text animation — no license risk",
          emotionalPurpose: "clarity",
          transition: "cut",
          estimatedSeconds: 12,
          confidence: "medium",
          accuracyWarning: "",
          needsMoreResearch: false,
        })),
      };
    }
    if (kind === "story-script") {
      const lines = [
        { text: `What do we actually know about ${topic}?`, kind: "hook", statement: "non-factual", evidenceRefs: [] as string[] },
        ...evidence.slice(0, 8).map((e, i) => ({
          text: e.claim.endsWith(".") ? e.claim : `${e.claim}.`,
          kind: (i === evidence.length - 1 ? "reveal" : "narration") as string,
          statement: "fact" as string,
          evidenceRefs: [e.ref],
          sceneIndex: i,
        })),
        { text: "That is what the verified sources establish — no more, no less.", kind: "takeaway", statement: "non-factual", evidenceRefs: [] as string[] },
      ];
      const words = lines.reduce((n, l) => n + l.text.split(/\s+/).length, 0);
      return {
        title: `${topic}: what the evidence shows`,
        lines,
        estimatedWords: words,
        estimatedSeconds: Math.max(10, Math.round(words / 2)),
      };
    }
    // story-critique
    const scriptLines = Array.isArray((ctx.script as any)?.lines) ? ((ctx.script as any).lines as { text: string }[]) : [];
    const findings: unknown[] = [];
    scriptLines.forEach((line, index) => {
      if (/\band then\b/i.test(line.text)) {
        findings.push({
          category: "and-then-beat",
          offendingLine: line.text,
          lineIndex: index,
          problem: '"and then" piles detail without tension (storytelling skill: the Dance).',
          suggestedRevision: line.text.replace(/\band then\b/i, "but"),
        });
      }
    });
    if (Boolean(settings) && scriptLines.length > 0 && !/\?|but /i.test(scriptLines[0]!.text)) {
      findings.push({
        category: "weak-hook",
        offendingLine: scriptLines[0]!.text,
        lineIndex: 0,
        problem: "Opening line does not pose a question or tension (mock heuristic).",
        suggestedRevision: "",
      });
    }
    return {
      findings,
      overallAssessment:
        findings.length === 0
          ? "Mechanical checks found no structural flags. Mock mode cannot judge narrative craft — connect a real provider for a substantive critique."
          : `Mechanical checks flagged ${findings.length} line(s). Mock mode cannot judge narrative craft beyond these patterns.`,
    };
  }

  private quizFeedback(ctx: Record<string, unknown>): unknown {
    const answers = Array.isArray(ctx.answers) ? (ctx.answers as any[]) : [];
    return {
      feedback: answers.map((a) => ({
        questionId: String(a.questionId ?? ""),
        correct: Boolean(
          a.answer &&
            a.correctAnswer &&
            String(a.answer).trim().toLowerCase().includes(String(a.correctAnswer).trim().toLowerCase().slice(0, 20))
        ),
        explanation: String(a.explanation ?? "Compare your answer with the model answer shown."),
      })),
    };
  }
}
