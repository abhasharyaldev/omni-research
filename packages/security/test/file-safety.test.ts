import { describe, expect, it } from "vitest";
import { escapeSpreadsheetCell, parseDelimited, rejectNonText, sanitizeFilename } from "../src/file-safety.js";

describe("filename sanitization", () => {
  it("strips path traversal and dangerous characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\windows\\system32\\evil.txt")).toBe("evil.txt");
    expect(sanitizeFilename('a<b>:"c|d?.md')).toBe("abcd.md");
    expect(sanitizeFilename("...hidden")).toBe("hidden");
    expect(sanitizeFilename("///")).toBe("import");
  });
});

describe("binary rejection (spoofed extensions / wrong MIME)", () => {
  it("rejects executables, archives, and PDFs claimed as text", () => {
    expect(rejectNonText(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toMatch(/executable/);
    expect(rejectNonText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toMatch(/zip/);
    expect(rejectNonText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toMatch(/pdf/);
    expect(rejectNonText(new TextEncoder().encode("hello\0world"))).toMatch(/NUL/);
  });
  it("accepts genuine text", () => {
    expect(rejectNonText(new TextEncoder().encode("# Heading\nplain text"))).toBeNull();
  });
});

describe("spreadsheet formula injection", () => {
  it("neutralizes formula-leading cells", () => {
    expect(escapeSpreadsheetCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(escapeSpreadsheetCell("+cmd|/c calc")).toBe("'+cmd|/c calc");
    expect(escapeSpreadsheetCell("@import")).toBe("'@import");
    expect(escapeSpreadsheetCell("normal value")).toBe("normal value");
  });
});

describe("CSV/TSV parser", () => {
  it("handles quoted fields, escaped quotes, and CRLF", () => {
    const rows = parseDelimited('a,b,c\r\n"x, y","he said ""hi""",3\n', ",");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "3"],
    ]);
  });
  it("parses TSV", () => {
    expect(parseDelimited("col1\tcol2\nv1\tv2", "\t")).toEqual([
      ["col1", "col2"],
      ["v1", "v2"],
    ]);
  });
});
