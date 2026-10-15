import { describe, expect, it } from "vitest";
import { AST_LANGUAGES, inferredAstLanguage, isAstLanguage } from "../src/ast-languages.js";
import { astCandidates } from "../src/ast.js";
import { parseConfig } from "../src/config.js";
import { inspectSource } from "../src/inspect.js";
import type { JevCheckRule } from "../src/types.js";

const source = [
  "using System;",
  "using System.Collections.Generic;",
  "public class Worker {",
  "  [Obsolete]",
  "  public List<string> Process() {",
  "    var result = queue.PublishAsync(",
  "      payload,",
  "      cancellationToken);",
  "    return new List<string>();",
  "  }",
  "}",
].join("\n");

describe("C# AST candidate selection", () => {
  it("uses a shared language registry for explicit values and extension inference", () => {
    expect(AST_LANGUAGES).toContain("csharp");
    expect(isAstLanguage("csharp")).toBe(true);
    expect(isAstLanguage("python")).toBe(false);
    expect(inferredAstLanguage("src/Handler.CS")).toBe("csharp");
    expect(inferredAstLanguage("src/index.ts")).toBe("typescript");
    expect(inferredAstLanguage("src/index.tsx")).toBe("tsx");
    expect(inferredAstLanguage("src/unknown.vue")).toBeUndefined();
  });

  it("matches multiline C# invocation patterns and keeps bounded ancestor context", () => {
    const result = astCandidates("src/Worker.cs", source, {
      pattern: "queue.PublishAsync($A, $B)",
      context: { ancestor: { kind: "method_declaration" } },
    }, 1000, "queue/check");
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      focusStartLine: 6,
      focusEndLine: 8,
      focusKind: "invocation_expression",
      focusStartColumn: 18,
    });
    expect(result.candidates[0]?.text).toContain("List<string> Process()");
    expect(result.candidates[0]?.text).toContain("return new List<string>()");
    expect(result.candidates[0]?.text.length).toBeLessThanOrEqual(1000);
  });

  it("supports kind, composite rule, attribute and generic selectors", () => {
    const call = astCandidates("src/Worker.cs", source,
      { language: "csharp", kind: "invocation_expression" }, 1000, "calls");
    expect(call.candidates.some((c) => c.text.includes("PublishAsync"))).toBe(true);

    const composite = astCandidates("src/Worker.cs", source,
      { language: "csharp", rule: { all: [{ kind: "invocation_expression" }, { regex: "PublishAsync" }] } },
      1000, "rule");
    expect(composite.candidates).toHaveLength(1);

    const attributes = astCandidates("src/Worker.cs", source,
      { language: "csharp", kind: "attribute" }, 1000, "attributes");
    expect(attributes.candidates.some((c) => c.text.includes("[Obsolete]"))).toBe(true);

    const generics = astCandidates("src/Worker.cs", source,
      { language: "csharp", kind: "generic_name" }, 1000, "generics");
    expect(generics.candidates.some((c) => c.text.includes("List<string>"))).toBe(true);
  });

  it("preserves UTF-16 focus columns and CRLF line ranges for C#", () => {
    const line = '    var café = "🧪"; Console.WriteLine(café);';
    const crlf = ["class Example {", "  void Run() {", line, "  }", "}"].join("\r\n");
    const result = astCandidates("Example.cs", crlf,
      { pattern: "Console.WriteLine($A)", contextBefore: 0, contextAfter: 0 }, 1000, "range");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      startLine: 3,
      endLine: 3,
      focusStartLine: 3,
      focusEndLine: 3,
      focusStartColumn: line.indexOf("Console.WriteLine") + 1,
    });
    expect(result.candidates[0]?.text).toBe(line);
  });

  it("skips oversize C# matches without sending a truncated request", () => {
    const big = 'class A { void Run() { Console.WriteLine("' + "x".repeat(400) + '"); } }';
    const result = astCandidates("A.cs", big,
      { pattern: "Console.WriteLine($A)" }, 256, "bounded");
    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics[0]?.message).toContain("matched node exceeds chunkChars");
  });

  it("rejects invalid C# language and selector configurations", () => {
    const config = (ast: object) => ({ rules: [{ id: "sample", question: "Is this unsafe?", ast }] });
    expect(() => parseConfig(config({ language: "python", kind: "invocation_expression" })))
      .toThrow("sample.ast.language must be");
    expect(() => parseConfig(config({ language: "csharp", kind: "not_a_real_csharp_node" })))
      .toThrow("sample.ast is invalid");
    expect(() => parseConfig(config({ language: "csharp", pattern: "" })))
      .toThrow("sample.ast.pattern must be");
    expect(() => parseConfig(config({ language: "csharp", pattern: "X", kind: "invocation_expression" })))
      .toThrow("exactly one of");
  });

  it("inspects a C# rule's exact bounded provider-free semantic request", () => {
    const rule: JevCheckRule = {
      id: "queue/check",
      question: "Can the handler report success if queue publication fails?",
      ast: { language: "csharp", kind: "method_declaration" },
      prefilter: "queue\\.PublishAsync\\(",
      files: ["**/*.cs"],
    };
    const result = inspectSource({ path: "src/Worker.cs", source }, [rule], { chunkChars: 1000 });
    expect(result.diagnostics).toEqual([]);
    expect(result.inspections).toHaveLength(1);
    const inspection = result.inspections[0]!;
    expect(inspection.request.state.path).toBe("src/Worker.cs");
    expect(inspection.request.state.code).toContain("return new List<string>()");
    expect(inspection.request.state.focusLineRange[0]).toBeLessThanOrEqual(5);
    expect(inspection.request.state.focusLineRange[1]).toBeGreaterThanOrEqual(10);
    expect(inspection.semanticKey).toBe(inspection.request.identity.key);
    expect(inspection.request.state.code.length).toBeLessThanOrEqual(1000);
  });
});
