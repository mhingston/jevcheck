import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { inspectSource } from "../src/inspect.js";

// Provider-free smoke test for the documentation's runnable example.
const root = process.cwd();
const folder = "examples/queue-ack";
const config = parseConfig(JSON.parse(
  readFileSync(join(root, folder, "jevcheck.config.json"), "utf8"),
) as unknown);

function inspect(path: string) {
  return inspectSource(
    { path, source: readFileSync(join(root, path), "utf8") },
    config.rules,
    {
      chunkChars: config.chunkChars,
      contextLines: config.contextLines,
      overlapLines: config.overlapLines,
    },
  );
}

describe("queue acknowledgement onboarding example", () => {
  it("has one bounded function candidate with the failure path and response visible", () => {
    const result = inspect(folder + "/src/handler.ts");
    expect(result.diagnostics).toEqual([]);
    expect(result.inspections).toHaveLength(1);
    const candidate = result.inspections[0]!;
    expect(candidate.selector).toBe("ast kind: function_declaration");
    expect(candidate.focusKind).toBe("function_declaration");
    expect(candidate.request.state.code).toContain("await queue.publish(job)");
    expect(candidate.request.state.code).toContain("catch (error)");
    expect(candidate.request.state.code).toContain("return accepted;");
    expect(candidate.request.question).toBeDefined();
  });

  it("includes one valid and one invalid fixture without provider access", () => {
    for (const [kind, filename] of [
      ["valid", "rejects-with-503.ts"],
      ["invalid", "logs-then-accepts.ts"],
    ]) {
      const result = inspect(folder + "/fixtures/" + kind + "/" + filename);
      expect(result.diagnostics).toEqual([]);
      expect(result.inspections).toHaveLength(1);
      expect(result.inspections[0]?.request.state.code).toContain("queue.publish(job)");
    }
  });

  it("rejects unrelated functions using the deterministic prefilter", () => {
    const result = inspectSource({
      path: folder + "/src/unrelated.ts",
      source: "export function square(n: number) { return n * n; }",
    }, config.rules);
    expect(result.inspections).toHaveLength(0);
  });
});
