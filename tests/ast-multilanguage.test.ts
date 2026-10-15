import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AST_LANGUAGES, inferredAstLanguage, isAstLanguage } from "../src/ast-languages.js";
import { astCandidates } from "../src/ast.js";
import { parseConfig } from "../src/config.js";
import { inspectSource } from "../src/inspect.js";
import type { AstLanguage, JevCheckRule } from "../src/types.js";

const cases = [
  { language: "python", extension: "py", kind: "call", ancestor: "function_definition" },
  { language: "go", extension: "go", kind: "call_expression", ancestor: "function_declaration" },
  { language: "java", extension: "java", kind: "method_invocation", ancestor: "method_declaration" },
  { language: "rust", extension: "rs", kind: "call_expression", ancestor: "function_item" },
] as const;

describe.each(cases)("$language AST integration", ({ language, extension, kind, ancestor }) => {
  const path = "examples/multilanguage-ast/sources/example." + extension;
  const source = readFileSync(path, "utf8");
  const focusLine = source.split("\n").findIndex((line) => line.includes("emit(café)")) + 1;
  const focusColumn = source.split("\n")[focusLine - 1]!.indexOf("emit(café)") + 1;

  it("registers explicit language and infers extension", () => {
    expect(AST_LANGUAGES).toContain(language);
    expect(isAstLanguage(language)).toBe(true);
    expect(inferredAstLanguage(path.toUpperCase())).toBe(language);
    expect(() => parseConfig({ rules: [{ id: "example", question: "Inspect?", ast: { language, kind } }] }))
      .not.toThrow();
  });

  it("selects pattern, kind and composite rules", () => {
    const pattern = astCandidates(path, source, { pattern: "emit($VALUE)" }, 1000, "example");
    const byKind = astCandidates(path, source, { language, kind }, 1000, "example");
    const composite = astCandidates(path, source, {
      language, rule: { all: [{ kind }, { regex: "emit" }] },
    }, 1000, "example");
    for (const selection of [pattern, byKind, composite]) {
      expect(selection.diagnostics).toEqual([]);
      expect(selection.candidates).toHaveLength(1);
      expect(selection.candidates[0]?.focusKind).toBe(kind);
      expect(selection.candidates[0]?.focusStartLine).toBe(focusLine);
      expect(selection.candidates[0]?.focusStartColumn).toBe(focusColumn);
    }
  });

  it("uses ancestor context without moving focus, preserving CRLF and Unicode columns", () => {
    const crlf = source.replaceAll("\n", "\r\n");
    const result = astCandidates(path, crlf, {
      language, pattern: "emit($VALUE)",
      contextBefore: 0, contextAfter: 0,
      context: { ancestor: { kind: ancestor } },
    }, 1000, "example");
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const selected = result.candidates[0]!;
    expect(selected.focusStartLine).toBe(focusLine);
    expect(selected.focusEndLine).toBe(focusLine);
    expect(selected.focusStartColumn).toBe(focusColumn);
    expect(selected.text).toContain('café');
    expect(selected.text).toContain('"🧪"');
    expect(selected.text).toContain("emit(café)");
    expect(selected.startLine).toBeLessThan(selected.focusStartLine);
    expect(selected.endLine).toBeGreaterThanOrEqual(selected.focusEndLine);
    expect(selected.text.length).toBeLessThanOrEqual(1000);
    expect(selected.text).not.toContain("\r");
  });

  it("rejects unknown selectors and refuses oversize matches", () => {
    expect(() => parseConfig({ rules: [{ id: "invalid", question: "Inspect?", ast: {
      language, kind: "never_a_tree_sitter_kind",
    } }] })).toThrow("Unknown AST node kind");
    const large = source.replace("emit(café)", 'emit("' + "x".repeat(400) + '")');
    const result = astCandidates(path, large, {
      language, pattern: "emit($VALUE)", contextBefore: 0, contextAfter: 0,
    }, 256, "example");
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("matched node exceeds chunkChars");
  });

  it("produces a provider-free, bounded inspect request", () => {
    const rule: JevCheckRule = {
      id: "example/" + language,
      files: ["**/*." + extension],
      question: "Could this call disclose a secret?",
      ast: {
        language: language as AstLanguage,
        pattern: "emit($VALUE)",
        contextBefore: 0, contextAfter: 0,
        context: { ancestor: { kind: ancestor } },
      },
    };
    const result = inspectSource({ path, source }, [rule], { chunkChars: 1000 });
    expect(result.diagnostics).toEqual([]);
    expect(result.inspections).toHaveLength(1);
    const inspected = result.inspections[0]!;
    expect(inspected.focusKind).toBe(kind);
    expect(inspected.focusLineRange).toEqual([focusLine, focusLine]);
    expect(inspected.request.state.code).toContain("emit(café)");
    expect(inspected.request.state.code).toContain('"🧪"');
    expect(inspected.request.state.code.length).toBeLessThanOrEqual(1000);
    expect(inspected.semanticKey).toBe(inspected.request.identity.key);
  });
});

describe("multi-language example configuration", () => {
  it("validates and selects exactly one AST focus for every supported example", () => {
    const config = parseConfig(JSON.parse(readFileSync("examples/multilanguage-ast/jevcheck.config.json", "utf8")));
    for (const { extension } of cases) {
      const path = "examples/multilanguage-ast/sources/example." + extension;
      const result = inspectSource({ path, source: readFileSync(path, "utf8") }, config.rules);
      expect(result.diagnostics).toEqual([]);
      expect(result.inspections).toHaveLength(1);
      expect(result.inspections[0]?.request.state.code).toContain('café');
    }
  });
});
