import { describe, expect, it } from "vitest";
import { auditJson, evidenceState, formatCommandError, formatCommandJson, requestedFormat } from "../src/cli-output.js";
import { formatInspectionStylish } from "../src/inspect.js";
import type { RuleEvidenceReport } from "../src/types.js";

const report: RuleEvidenceReport = {
  ruleId: "safety/example", currentStatus: "owned", execution: "semantic",
  checks: [{ id: "fixtures", status: "block", message: "no invalid fixtures" }],
  blockers: ["no invalid fixtures"], warnings: [], readyForOwned: false,
};

describe("CLI presentation contracts", () => {
  it("retains v1 audit array, evidence checks and actionable diagnostics", () => {
    const json = JSON.parse(formatCommandJson("rules-audit", [report], "json"));
    expect(Array.isArray(json)).toBe(true);
    expect(json[0].checks).toEqual(report.checks);
    expect(json[0].diagnostics).toMatchObject([{
      code: "EVIDENCE_FIXTURES", level: "error", ruleId: "safety/example",
      suggestedCommand: "jevcheck test",
    }]);
  });

  it("provides opt-in v2 command identity, result, summary and full detailed data", () => {
    const parsed = JSON.parse(formatCommandJson("rules-audit", [report], "json-v2"));
    expect(parsed).toMatchObject({
      schemaVersion: 2, command: "rules-audit", outcome: "block",
      summary: { rules: 1, blocked: 1 }, data: [{ ruleId: "safety/example" }],
    });
    expect(parsed.diagnostics[0].code).toBe("EVIDENCE_FIXTURES");
  });

  it("keeps reviewed-only, verified CI and inapplicability separate", () => {
    const reviewed: RuleEvidenceReport = {
      ...report, execution: "covered", currentStatus: "shadow", blockers: [],
      checks: [{ id: "coverage", status: "pass",
        message: "human-reviewed deterministic coverage is current; shadow semantic judge skipped (CI execution not verified)" }],
    };
    const verified: RuleEvidenceReport = {
      ...reviewed, currentStatus: "owned",
      checks: [{ id: "coverage", status: "pass",
        message: "reviewed coverage with passing CI commands for all coveredBy checks" }],
    };
    expect(evidenceState(reviewed)).toBe("reviewed-only");
    expect(evidenceState(verified)).toBe("ci-verified");
    expect(evidenceState({ ...report, execution: "inapplicable", blockers: [] })).toBe("inapplicable");
    expect(auditJson([reviewed])[0].state).toBe("reviewed-only");
  });

  it("uses structured errors for invalid arguments in both modes", () => {
    for (const format of ["json", "json-v2"] as const) {
      const parsed = JSON.parse(formatCommandError("check", Error("unknown option: --oops"), format));
      expect(parsed.outcome).toBe("error");
      expect(parsed.diagnostics).toMatchObject([{ code: "INVALID_ARGUMENT" }]);
      expect(parsed.error.remediation).toBeTruthy();
    }
    expect(requestedFormat(["coverage", "verify", "--", "node", "--format", "json"])).toBeUndefined();
  });

  it("defaults inspect to policy and hides requests and keys outside verbose", () => {
    const value = { rules: [{
      ruleId: "r", path: "a.ts", execution: "semantic" as const, reason: "eligible",
      selector: "whole file", selectorRan: true, candidateCount: 1, selectorDiagnostics: [],
    }], inspections: [{
      ruleId: "r", path: "a.ts", execution: "semantic" as const, reason: "eligible",
      previewOnly: false, selector: "whole file", range: [1,1] as [number,number],
      focusLineRange: [1,1] as [number,number], semanticKey: "private-key",
      estimatedRequestChars: 32, request: { state: { code: "private-request" }, question: "question" },
    }], diagnostics: [] };
    const compact = formatInspectionStylish(value as any);
    expect(compact).toContain("Inspect:");
    expect(compact).not.toContain("private-request");
    expect(compact).not.toContain("private-key");
    expect(formatInspectionStylish(value as any, true)).toContain("private-request");
    expect(JSON.parse(formatCommandJson("inspect", value, "json")).inspections[0].request.state.code)
      .toBe("private-request");
  });
});
