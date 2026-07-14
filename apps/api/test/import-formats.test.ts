import { describe, expect, it } from "vitest";
import { parseBibtex, parseSubtitles, parseDocx, msToClock } from "../src/services/import-formats.js";

describe("BibTeX parser", () => {
  it("extracts structured metadata, preserves unknown fields, and normalizes DOI", () => {
    const bib = `@article{smith2020,
      title = {Spaced Repetition and Retention},
      author = {Smith, Jane and Doe, John},
      journal = {Journal of Learning},
      year = {2020},
      doi = {https://doi.org/10.1000/xyz123},
      customfield = {kept verbatim}
    }`;
    const { entries } = parseBibtex(bib);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.entryType).toBe("article");
    expect(e.citeKey).toBe("smith2020");
    expect(e.title).toBe("Spaced Repetition and Retention");
    expect(e.authors).toContain("Smith, Jane");
    expect(e.doi).toBe("10.1000/xyz123");
    expect(e.fields.customfield).toBe("kept verbatim"); // unknown field preserved
  });

  it("warns instead of throwing on entries missing title/author", () => {
    const { entries } = parseBibtex("@misc{x, year={2021}}");
    expect(entries[0]!.warnings).toContain("no title field");
  });
});

describe("SRT/WebVTT parser", () => {
  it("parses SRT with exact timestamps and IDs", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
Second cue`;
    const { cues } = parseSubtitles(srt, "srt");
    expect(cues).toHaveLength(2);
    expect(cues[0]!.id).toBe("1");
    expect(cues[0]!.start).toBe("00:00:01,000");
    expect(cues[0]!.startMs).toBe(1000);
    expect(cues[1]!.startMs).toBe(5500);
    expect(cues[1]!.text).toBe("Second cue");
  });

  it("parses WebVTT with speaker voice tags and language", () => {
    const vtt = `WEBVTT
Language: en

00:00:00.000 --> 00:00:02.000
<v Alice>Good morning`;
    const { cues, language } = parseSubtitles(vtt, "vtt");
    expect(language).toBe("en");
    expect(cues[0]!.speaker).toBe("Alice");
    expect(cues[0]!.text).toBe("Good morning");
  });

  it("reports malformed cues instead of silently dropping them", () => {
    const srt = `1
NOT A TIMESTAMP
text`;
    const { cues, warnings } = parseSubtitles(srt, "srt");
    expect(cues).toHaveLength(0);
    expect(warnings.some((w) => /without a timestamp/.test(w))).toBe(true);
  });

  it("formats clock timestamps", () => {
    expect(msToClock(3_674_000)).toBe("01:01:14");
  });
});

describe("DOCX parser", () => {
  // Build a minimal real OOXML docx in-memory (a genuine zip with the parts).
  async function makeDocx(documentXml: string, extraFiles: Record<string, string> = {}): Promise<Buffer> {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types/>');
    zip.file("word/document.xml", documentXml);
    for (const [name, content] of Object.entries(extraFiles)) zip.file(name, content);
    return zip.generateAsync({ type: "nodebuffer" });
  }

  it("extracts headings and paragraphs from real OOXML", async () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body text here.</w:t></w:r></w:p>
    </w:body></w:document>`;
    const result = await parseDocx(await makeDocx(xml));
    expect(result.paragraphs).toHaveLength(2);
    expect(result.paragraphs[0]).toEqual({ text: "Introduction", heading: 1 });
    expect(result.paragraphs[1]!.heading).toBeNull();
    expect(result.hasMacros).toBe(false);
  });

  it("flags macros without executing them, still extracting text", async () => {
    const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Safe text</w:t></w:r></w:p></w:body></w:document>`;
    const result = await parseDocx(await makeDocx(xml, { "word/vbaProject.bin": "fake-macro-bytes" }));
    expect(result.hasMacros).toBe(true);
    expect(result.warnings.some((w) => /macro/i.test(w))).toBe(true);
    expect(result.paragraphs[0]!.text).toBe("Safe text");
  });

  it("rejects a non-OOXML buffer (spoofed extension)", async () => {
    await expect(parseDocx(Buffer.from("not a zip", "utf8"))).rejects.toThrow(/OOXML|ZIP/i);
  });
});
