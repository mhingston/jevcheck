import { describe, expect, it } from "vitest";
import { astCandidates } from "../src/ast.js";
import { parseConfig } from "../src/config.js";

describe("ast candidates", () => {
  it("infers TypeScript and applies checker-wide context when rule context is omitted", () => {
    const source = [
      "const before = 1;",
      "console.log(secret);",
      "const after = 2;",
    ].join("\n");

    const result = astCandidates(
      "src/a.ts",
      source,
      { pattern: "console.log($A)" },
      200,
      "security/no-sensitive-log",
      1,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      startLine: 1,
      endLine: 3,
      focusStartLine: 2,
      focusEndLine: 2,
      focusStartColumn: 1,
      focusKind: "call_expression",
    });
  });

  it("supports kind selectors and nearest ancestor context while preserving exact focus", () => {
    const source = [
      "function run() {",
      "  const value = secret;",
      "  console.log(value);",
      "}",
    ].join("\n");

    const result = astCandidates(
      "src/a.ts",
      source,
      {
        kind: "call_expression",
        contextBefore: 0,
        contextAfter: 0,
        context: { ancestor: { kind: "function_declaration" } },
      },
      500,
      "example",
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      startLine: 1,
      endLine: 4,
      focusStartLine: 3,
      focusEndLine: 3,
    });
    expect(result.candidates[0]?.text).toContain("function run()");
  });

  it("reports UTF-16 columns even when ast-grep positions pass through UTF-8 text", () => {
    const source = "const ü = 1; console.log(secret);";
    const result = astCandidates(
      "src/a.ts",
      source,
      { pattern: "console.log($A)", contextBefore: 0, contextAfter: 0 },
      500,
      "example",
    );

    expect(result.candidates[0]).toMatchObject({
      focusStartLine: 1,
      focusEndLine: 1,
      focusStartColumn: source.indexOf("console.log") + 1,
    });
  });

  it("skips an ast node that itself exceeds the semantic request bound", () => {
    const source = "console.log(" + JSON.stringify("x".repeat(300)) + ");";
    const result = astCandidates(
      "src/a.ts",
      source,
      { pattern: "console.log($A)", contextBefore: 0, contextAfter: 0 },
      256,
      "example",
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics[0]?.message).toContain("matched node exceeds chunkChars");
  });

  it("warns when language inference is unavailable", () => {
    const result = astCandidates(
      "src/a.vue",
      "console.log(secret);",
      { pattern: "console.log($A)" },
      500,
      "example",
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics[0]?.message).toContain("no built-in language mapping");
  });

  it("validates selector configuration", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Does this violate the rule?",
          ast: { pattern: "console.log($A)" },
        }],
      }),
    ).not.toThrow();

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Does this violate the rule?",
          ast: { pattern: "console.log($A)", kind: "call_expression" },
        }],
      }),
    ).toThrow("example.ast must define exactly one of pattern, kind, or rule");
  });
});
