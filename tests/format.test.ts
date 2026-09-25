import { describe, expect, it } from "vitest";
import { formatSarif } from "../src/format.js";
import type { CheckResult } from "../src/types.js";

function resultForPath(path: string): CheckResult {
  return {
    findings: [{
      ruleId: "security/no-log",
      path,
      startLine: 4,
      endLine: 4,
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
      inputTokens: 10,
      outputTokens: 1,
    },
  };
}

describe("SARIF", () => {
  it("emits active findings with stable partial fingerprints", () => {
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

  it("normalizes and URI-encodes artifact paths", () => {
    const parsed = JSON.parse(formatSarif(resultForPath("src\\folder name\\a#b.ts"))) as any;
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri)
      .toBe("src/folder%20name/a%23b.ts");
  });
});
