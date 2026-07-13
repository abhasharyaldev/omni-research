import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockProvider } from "../src/adapters/mock-provider.js";
import { extractJsonCandidate, parseStructured } from "../src/structured-output.js";
import { ProcessRunner } from "../src/process-runner.js";
import { evidenceOutputSchema } from "../../research-engine/src/schemas.js";

describe("structured output extraction", () => {
  it("extracts fenced JSON", () => {
    const text = 'Sure! Here you go:\n```json\n{"a": 1}\n```\nHope that helps.';
    expect(extractJsonCandidate(text)).toBe('{"a": 1}');
  });

  it("extracts balanced JSON embedded in prose (ignoring braces in strings)", () => {
    const text = 'prefix {"a": "has } brace", "b": [1,2]} suffix';
    expect(JSON.parse(extractJsonCandidate(text)!)).toEqual({ a: "has } brace", b: [1, 2] });
  });

  it("validates against a schema and reports mismatches", () => {
    const schema = z.object({ n: z.number() });
    expect(parseStructured('{"n": 4}', schema)).toEqual({ ok: true, value: { n: 4 } });
    const bad = parseStructured('{"n": "x"}', schema);
    expect(bad.ok).toBe(false);
  });

  it("repairs trailing commas but nothing semantic", () => {
    const schema = z.object({ list: z.array(z.number()) });
    expect(parseStructured('{"list": [1,2,],}', schema)).toEqual({ ok: true, value: { list: [1, 2] } });
  });
});

describe("mock provider", () => {
  const mock = new MockProvider();

  it("reports itself installed and authenticated with no account", async () => {
    expect((await mock.checkInstallation()).installed).toBe(true);
    expect((await mock.checkAuthentication()).authenticated).toBe(true);
  });

  it("extracts evidence only from supplied sentences (no fabrication)", async () => {
    const sentences = [
      "Spaced repetition is a study technique in which review sessions are separated by increasing intervals of time.",
      "Students who spread five hours of study across two weeks outperform students who cram.",
      "Unrelated filler sentence about the weather being nice today over the hills.",
    ];
    const output = await mock.generateStructured(
      {
        requestId: "t1",
        taskKind: "evidence-extraction",
        instructions: "extract",
        schemaDescription: "{}",
        context: {
          query: "spaced repetition study retention",
          subquestions: ["What is spaced repetition?"],
          sources: [{ sourceId: "s1", title: "T", url: "u", sentences }],
        },
      },
      evidenceOutputSchema
    );
    expect(output.evidence.length).toBeGreaterThan(0);
    for (const record of output.evidence) {
      expect(sentences).toContain(record.evidenceText); // verbatim, never invented
      expect(record.sourceId).toBe("s1");
    }
  });

  it("produces a deterministic research plan", async () => {
    const schema = z.object({ mainQuestion: z.string(), subquestions: z.array(z.string()).min(1) });
    const output = await mock.generateStructured(
      {
        requestId: "t2",
        taskKind: "research-plan",
        instructions: "plan",
        schemaDescription: "{}",
        context: { prompt: "Compare solar and wind power", topics: ["solar power", "wind power"] },
      },
      schema
    );
    expect(output.subquestions.length).toBeGreaterThanOrEqual(3);
  });

  it("never claims real synthesis quality", async () => {
    const schema = z.object({ sections: z.array(z.object({ kind: z.string(), title: z.string(), contentMd: z.string() })) });
    const output = await mock.generateStructured(
      {
        requestId: "t3",
        taskKind: "synthesis",
        instructions: "write",
        schemaDescription: "{}",
        context: { mainQuestion: "Q", subquestions: ["A"], evidence: [] },
      },
      schema
    );
    const limitations = output.sections.find((s) => s.kind === "limitations");
    expect(limitations?.contentMd).toContain("mock provider");
  });
});

describe("process runner safety", () => {
  it("refuses executables that are not allowlisted", async () => {
    const runner = new ProcessRunner({
      timeoutMs: 5000,
      maxConcurrent: 1,
      maxInputChars: 1000,
      maxOutputChars: 1000,
      workspaceRoot: ".local-ai-workspaces-test",
    });
    await expect(
      runner.run({ requestId: "x", executable: "powershell.exe", args: ["-c", "echo hi"] })
    ).rejects.toThrow(/not in the provider allowlist/);
  });

  it("rejects oversized input before spawning", async () => {
    const runner = new ProcessRunner({
      timeoutMs: 5000,
      maxConcurrent: 1,
      maxInputChars: 10,
      maxOutputChars: 1000,
      workspaceRoot: ".local-ai-workspaces-test",
    });
    runner.allowExecutable("node");
    await expect(
      runner.run({ requestId: "y", executable: "node", args: ["-e", "1"], stdin: "x".repeat(100) })
    ).rejects.toThrow(/exceeds AI_MAX_INPUT_CHARACTERS/);
  });

  it("runs an allowlisted executable with filtered env and captures output", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-leak";
    const runner = new ProcessRunner({
      timeoutMs: 15_000,
      maxConcurrent: 1,
      maxInputChars: 10_000,
      maxOutputChars: 10_000,
      workspaceRoot: ".local-ai-workspaces-test",
    });
    runner.allowExecutable(process.execPath);
    const result = await runner.run({
      requestId: "z",
      executable: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({key: process.env.ANTHROPIC_API_KEY ?? null}))'],
    });
    delete process.env.ANTHROPIC_API_KEY;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ key: null }); // never forwarded
  });
});
