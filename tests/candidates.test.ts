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
    expect(result.candidates[0]).toMatchObject({ startLine: 2, endLine: 4 });
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
