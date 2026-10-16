import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { inspectSource } from "../src/inspect.js";

describe("C# queue example", () => {
  it("focuses the whole decision-relevant handler in safe and unsafe fixtures", async () => {
    const config = parseConfig(JSON.parse(readFileSync("examples/csharp-queue/jevcheck.config.json", "utf8")));
    for (const [fixture, expectedReturn] of [
      ["examples/csharp-queue/fixtures/valid/rejects-failure.cs", "return 503"],
      ["examples/csharp-queue/fixtures/invalid/acknowledges-failure.cs", "return 202"],
    ]) {
      const code = readFileSync(fixture, "utf8");
      const result = await inspectSource({ path: fixture, source: code }, config.rules);
      expect(result.diagnostics).toEqual([]);
      expect(result.inspections).toHaveLength(1);
      const inspection = result.inspections[0]!;
      expect(inspection.focusKind).toBe("method_declaration");
      expect(inspection.request.state.code).toContain("queue.PublishAsync");
      expect(inspection.request.state.code).toContain("catch (Exception ex)");
      expect(inspection.request.state.code).toContain(expectedReturn);
      expect(inspection.request.state.code).not.toContain("public interface IQueuePublisher");
      expect(inspection.focusLineRange[0]).toBeGreaterThan(1);
      expect(inspection.focusLineRange[1]).toBeLessThan(code.split(/\r?\n/).length);
    }
  });
});
