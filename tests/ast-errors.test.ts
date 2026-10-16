import { describe, expect, it, vi } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { astCandidates } from "../src/ast.js";
import { buildCandidates } from "../src/candidates.js";
import { createJevCheck } from "../src/engine.js";

// Tree-sitter normally recovers from malformed source. Inject hard native
// exceptions to prove that genuine parser/matcher failures are not swallowed.
vi.mock("@ast-grep/napi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ast-grep/napi")>();
  return {
    ...actual,
    parse: (language: Parameters<typeof actual.parse>[0], source: string) => {
      if (source.includes("__parse_failure__")) {
        throw new Error("simulated parser failure");
      }
      if (source.includes("__find_failure__")) {
        return {
          root: () => ({
            findAll: () => { throw new Error("simulated matcher failure"); },
          }),
        } as unknown as ReturnType<typeof actual.parse>;
      }
      return actual.parse(language, source);
    },
  };
});

const options = { chunkChars: 6000, overlapLines: 0, contextLines: 0 };

class CountingClient implements SystemOneLikeClient {
  calls = 0;

  async systemOne(_request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    return { model: "test-model", answers: { violation: { type: "noul", noul: 0.1 } } };
  }
}

describe("AST grammar validation and failures", () => {
  it("accepts explicit and extension-inferred selectors in their effective grammars", () => {
    const explicit = astCandidates(
      "src/example.unknown", "function run() { return 1; }",
      { language: "typescript", kind: "function_declaration" }, 6000, "test/ast",
    );
    const inferred = astCandidates(
      "src/example.py", "def run():\n    return 1",
      { kind: "function_definition" }, 6000, "test/ast",
    );

    expect(explicit.diagnostics).toEqual([]);
    expect(explicit.candidates).toHaveLength(1);
    expect(inferred.diagnostics).toEqual([]);
    expect(inferred.candidates).toHaveLength(1);
  });

  it("rejects invalid kinds in a mixed-language rule without discarding valid files", () => {
    const rule = {
      id: "test/mixed-grammar",
      question: "Is this declaration unsafe?",
      ast: { kind: "function_declaration" },
    };
    const ts = buildCandidates("src/a.ts", "function run() {}", rule, options);
    const py = buildCandidates("src/b.py", "def run():\n    pass", rule, options);

    expect(ts.diagnostics).toEqual([]);
    expect(ts.candidates).toHaveLength(1);
    expect(py.candidates).toEqual([]);
    expect(py.diagnostics).toEqual([expect.objectContaining({
      code: "incomplete-evaluation",
      level: "warning",
      ruleId: rule.id,
      path: "src/b.py",
      message: expect.stringMatching(/selector validation failed for language 'python'.*function_declaration/),
    })]);
  });

  it("validates both selectors even when a prefilter has no matches", () => {
    const rule = {
      id: "test/invalid-ancestor",
      question: "Is this safe?",
      prefilter: "never_present",
      ast: {
        kind: "function_definition",
        context: { ancestor: { kind: "function_declaration" } },
      },
    };
    const result = buildCandidates("src/a.py", "x = 1", rule, options);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "incomplete-evaluation",
      path: "src/a.py",
      ruleId: rule.id,
      message: expect.stringContaining("function_declaration"),
    })]);
  });

  it("reports parser and matching exceptions as language-scoped incomplete evaluations", () => {
    for (const [marker, stage, error] of [
      ["__parse_failure__", "source parsing", "simulated parser failure"],
      ["__find_failure__", "candidate matching", "simulated matcher failure"],
    ]) {
      const result = astCandidates(
        "src/a.ts", "console.log(secret); // " + marker,
        { pattern: "console.log($A)" }, 6000, "test/parser",
      );
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: "incomplete-evaluation",
        path: "src/a.ts",
        ruleId: "test/parser",
        message: expect.stringContaining("AST " + stage + " failed for language 'typescript': " + error),
      })]);
    }
  });

  it("keeps other source results and fails an owned rule closed on parser errors", async () => {
    const client = new CountingClient();
    const rule = {
      id: "test/owned-ast",
      question: "Is the console log unsafe?",
      severity: "error" as const,
      status: "owned" as const,
      ast: { pattern: "console.log($A)" },
    };
    const check = createJevCheck({
      client,
      rules: [rule],
      mode: "enforce",
      ruleEvidenceReports: [{
        ruleId: rule.id,
        currentStatus: "owned",
        checks: [],
        blockers: [],
        warnings: [],
        readyForOwned: true,
      }],
    });
    const result = await check.checkSources([
      { path: "src/first.ts", source: "console.log(first);" },
      { path: "src/broken.ts", source: "// __parse_failure__" },
      { path: "src/last.ts", source: "console.log(last);" },
    ]);

    expect(client.calls).toBe(2);
    expect(result.evaluations).toHaveLength(2);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      code: "incomplete-evaluation",
      level: "error",
      path: "src/broken.ts",
      ruleId: rule.id,
      message: expect.stringContaining("simulated parser failure"),
    })]);
  });
});
