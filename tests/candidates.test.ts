import { describe, expect, it } from "vitest";
import { buildCandidates } from "../src/candidates.js";

describe("buildCandidates", () => {
  it("narrows prefiltered rules to nearby context", () => {
    const source = [
      "const a = 1;",
      "const b = 2;",
      "console.log(secret);",
      "const c = 3;",
      "const d = 4;",
    ].join("\n");

    const result = buildCandidates(
      "src/example.ts",
      source,
      {
        id: "security/no-secret-log",
        question: "Does this log a secret?",
        prefilter: "console\\.log",
        contextLines: 1,
      },
      { chunkChars: 6000, overlapLines: 0, contextLines: 20 },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      startLine: 2,
      endLine: 4,
      focusStartLine: 2,
      focusEndLine: 4,
    });
    expect(result.candidates[0].text).toContain("console.log(secret)");
  });

  it("skips oversized whole-file rules rather than truncating them", () => {
    const result = buildCandidates(
      "src/example.ts",
      "x".repeat(1000),
      {
        id: "architecture/missing-registration",
        question: "Is required registration missing?",
        wholeFile: true,
      },
      { chunkChars: 256, overlapLines: 0, contextLines: 20 },
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics[0]?.message).toContain("Whole-file rule skipped");
  });

  it("never emits an oversized candidate when one source line exceeds the bound", () => {
    const result = buildCandidates(
      "src/example.ts",
      ["short", "x".repeat(40), "end"].join("\n"),
      {
        id: "example",
        question: "Does this violate the rule?",
      },
      { chunkChars: 10, overlapLines: 1, contextLines: 20 },
    );

    expect(result.candidates.every((candidate) => candidate.text.length <= 10)).toBe(true);
    expect(result.diagnostics.some((item) => item.message.includes("Line 2 skipped"))).toBe(true);
  });

  it("keeps overlap as context while assigning each source line to one focus range", () => {
    const result = buildCandidates(
      "src/example.ts",
      ["aaaaa", "bbbbb", "ccccc", "ddddd"].join("\n"),
      {
        id: "example",
        question: "Does this violate the rule?",
      },
      { chunkChars: 17, overlapLines: 1, contextLines: 20 },
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ focusStartLine: 1, focusEndLine: 3 });
    expect(result.candidates[1]).toMatchObject({ startLine: 3, focusStartLine: 4, focusEndLine: 4 });
    expect(result.candidates.every((candidate) => candidate.text.length <= 17)).toBe(true);
  });

  it("does not retain global regex state across unless candidates", () => {
    const result = buildCandidates(
      "src/example.ts",
      ["console.log(a); // safe", "x", "console.log(b); // safe"].join("\n"),
      {
        id: "example",
        question: "Does this violate the rule?",
        prefilter: "console\\.log",
        contextLines: 0,
        unless: "/safe/g",
      },
      { chunkChars: 6000, overlapLines: 0, contextLines: 20 },
    );

    expect(result.candidates).toHaveLength(0);
  });
});
