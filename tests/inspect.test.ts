import { describe, expect, it } from "vitest";
import { inspectSource } from "../src/inspect.js";
import type { JevCheckRule } from "../src/types.js";

describe("semantic request inspection", () => {
  it("uses the same bounded semantic request shape without calling a provider", () => {
    const rule: JevCheckRule = {
      id: "security/no-sensitive-log",
      question: "Does this logging call expose a sensitive value?",
      prefilter: "console\\.log",
      contextLines: 0,
      criteria: {
        true: "A sensitive value reaches the logging call.",
        false: "Only non-sensitive data reaches the logging call.",
      },
    };

    const result = inspectSource(
      { path: "src/example.ts", source: "const safe = 1;\nconsole.log(secret);\n" },
      [rule],
      { chunkChars: 1000, overlapLines: 0, contextLines: 0 },
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.inspections).toHaveLength(1);
    const inspection = result.inspections[0]!;
    expect(inspection.ruleId).toBe(rule.id);
    expect(inspection.selector).toContain("prefilter");
    expect(inspection.request.state.path).toBe("src/example.ts");
    expect(inspection.request.state.focusLineRange).toEqual([2, 2]);
    expect(inspection.request.state.code).toBe("console.log(secret);");
    expect(inspection.semanticKey).toBe(inspection.request.identity.key);
    expect(inspection.estimatedRequestChars).toBeGreaterThan(0);
  });

  it("respects file applicability before constructing candidates", () => {
    const rule: JevCheckRule = {
      id: "security/no-sensitive-log",
      question: "Does this logging call expose a sensitive value?",
      files: ["src/**/*.ts"],
      prefilter: "console\\.log",
    };

    const result = inspectSource(
      { path: "test/example.ts", source: "console.log(secret);" },
      [rule],
    );

    expect(result.inspections).toEqual([]);
  });
});
