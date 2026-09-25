import { describe, expect, it } from "vitest";
import { astCandidates } from "../src/ast.js";
import { parseConfig } from "../src/config.js";

describe("ast candidates", () => {
  it("selects exact ast-grep nodes and keeps bounded surrounding context", () => {
    const source = [
      "const before = 1;",
      "console.log(secret);",
      "const middle = 2;",
      "console.log(redacted);",
      "const after = 3;",
    ].join("\n");

    const result = astCandidates(
      "src/a.ts",
      source,
      {
        language: "typescript",
        rule: { pattern: "console.log($A)" },
        contextBefore: 1,
        contextAfter: 1,
      },
      200,
      "security/no-sensitive-log",
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      startLine: 1,
      endLine: 3,
      focusStartLine: 2,
      focusEndLine: 2,
    });
    expect(result.candidates[1]).toMatchObject({
      startLine: 3,
      endLine: 5,
      focusStartLine: 4,
      focusEndLine: 4,
    });
  });

  it("skips an ast node that itself exceeds the semantic request bound", () => {
    const source = "console.log(" + JSON.stringify("x".repeat(300)) + ");";
    const result = astCandidates(
      "src/a.ts",
      source,
      { language: "typescript", rule: { pattern: "console.log($A)" } },
      256,
      "example",
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics[0]?.message).toContain("matched node exceeds chunkChars");
  });

  it("validates ast configuration at config load time", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Does this violate the rule?",
          ast: {
            language: "typescript",
            rule: { pattern: "console.log($A)" },
          },
        }],
      }),
    ).not.toThrow();

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Does this violate the rule?",
          ast: {
            language: "javascript",
            rule: { pattern: "console.log($A)" },
          },
        }],
      }),
    ).toThrow("example.ast.language must be typescript or tsx");
  });
});
