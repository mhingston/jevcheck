import { describe, expect, it } from "vitest";
import {
  formatFixtureDriftStylish,
  formatFixtureStylish,
  formatSarif,
  formatStylish,
} from "../src/format.js";
import type { CheckResult, FixtureRunResult } from "../src/types.js";

function resultForPath(path: string, columns = false): CheckResult {
  return {
    findings: [{
      ruleId: "security/no-log",
      path,
      startLine: 4,
      endLine: 4,
      ...(columns ? { startColumn: 3, endColumn: 12, focusKind: "call_expression" } : {}),
      probability: 0.93,
      threshold: 0.8,
      model: "jev",
      cached: false,
      violates: true,
      ruleHash: "rule",
      codeHash: "code",
      severity: "error",
      status: "owned",
      blocking: true,
      fingerprint: "abc123",
      why: "Sensitive values must not be logged.",
    }],
    suppressedFindings: [],
    evaluations: [],
    diagnostics: [],
    stats: {
      filesChecked: 1,
      candidatesChecked: 1,
      requests: 1,
      cacheHits: 0,
      replayHits: 0,
      replayMisses: 0,
      inputTokens: 10,
      outputTokens: 1,
    },
  };
}

describe("formatting", () => {
  it("emits active SARIF findings with stable partial fingerprints", () => {
    const parsed = JSON.parse(formatSarif(resultForPath("src/a.ts"))) as any;
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs[0].results[0]).toMatchObject({
      ruleId: "security/no-log",
      level: "error",
      partialFingerprints: { "jevcheck/v1": "abc123" },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: "src/a.ts" },
          region: { startLine: 4, endLine: 4 },
        },
      }],
    });
  });

  it("includes precise AST columns in stylish and SARIF output", () => {
    const result = resultForPath("src/a.ts", true);
    expect(formatStylish(result)).toContain("src/a.ts:4:3-4:12");

    const parsed = JSON.parse(formatSarif(result)) as any;
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.region).toMatchObject({
      startLine: 4,
      endLine: 4,
      startColumn: 3,
      endColumn: 12,
    });
    expect(parsed.runs[0].results[0].properties.focusKind).toBe("call_expression");
  });

  it("surfaces thin fixture margins and drift without treating them as failures", () => {
    const fixtures: FixtureRunResult = {
      tests: [{
        ruleId: "security/no-log",
        path: "fixtures/a.ts",
        expected: "invalid",
        passed: true,
        maxProbability: 0.82,
        threshold: 0.8,
        margin: 0.02,
        thinMargin: true,
        semanticKeys: ["semantic-a"],
        model: "jev-a",
      }],
      diagnostics: [],
      stats: {
        filesChecked: 1,
        candidatesChecked: 1,
        requests: 1,
        cacheHits: 0,
        replayHits: 0,
        replayMisses: 0,
        inputTokens: 10,
        outputTokens: 1,
      },
    };
    expect(formatFixtureStylish(fixtures)).toContain("THIN");
    expect(formatFixtureStylish(fixtures)).toContain("0 failure(s), 1 thin margin(s)");

    const drift = formatFixtureDriftStylish({
      compared: 1,
      meanAbsoluteDelta: 0.12,
      moved: [{
        ruleId: "security/no-log",
        path: "fixtures/a.ts",
        expected: "invalid",
        before: 0.94,
        after: 0.82,
        delta: 0.12,
        beforeThreshold: 0.8,
        afterThreshold: 0.8,
        beforeModel: "jev-a",
        afterModel: "jev-b",
      }],
      stale: [],
      added: [],
      removed: [],
      driftThreshold: 0.1,
    });
    expect(drift).toContain("mean |Δp| 0.120");
    expect(drift).toContain("jev-a -> jev-b");
  });

  it("normalizes and URI-encodes artifact paths", () => {
    const parsed = JSON.parse(formatSarif(resultForPath("src\\folder name\\a#b.ts"))) as any;
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri)
      .toBe("src/folder%20name/a%23b.ts");
  });
});
