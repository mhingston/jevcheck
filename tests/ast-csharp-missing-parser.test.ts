import { describe, expect, it, vi } from "vitest";

vi.mock("@ast-grep/napi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ast-grep/napi")>();
  return {
    ...actual,
    registerDynamicLanguage: () => { throw new Error("No parser found"); },
  };
});

describe("missing C# native parser diagnostics", () => {
  it("provides a repair hint during explicit config validation", async () => {
    const { parseConfig } = await import("../src/config.js");
    expect(() => parseConfig({
      rules: [{ id: "csharp", question: "Is this unsafe?", ast: {
        language: "csharp", kind: "invocation_expression",
      } }],
    })).toThrow(/Cannot load the C# AST parser.*lifecycle scripts/);
  });

  it("returns an actionable offline diagnostic for inferred C# files", async () => {
    const { astCandidates } = await import("../src/ast.js");
    const result = astCandidates("A.cs", "class A {}", { kind: "class_declaration" }, 500, "rule");
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toMatchObject([{
      level: "error",
      path: "A.cs",
      ruleId: "rule",
    }]);
    expect(result.diagnostics[0]?.message).toContain("@ast-grep/lang-csharp");
    expect(result.diagnostics[0]?.message).toContain("--allow-build");
  });
});
