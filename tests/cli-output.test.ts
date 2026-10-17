import { describe, expect, it } from "vitest";
import { CliConfigError, auditJson, evidenceState, formatCommandError, formatCommandJson, requestedFormat } from "../src/cli-output.js";
import { OwnedRuleEvidenceError } from "../src/graduation.js";
import { formatInspectionStylish } from "../src/inspect.js";
import type { RuleEvidenceReport } from "../src/types.js";

const report: RuleEvidenceReport = {
  ruleId: "safety/example", currentStatus: "owned", execution: "semantic",
  checks: [{ id: "fixtures", status: "block", message: "no invalid fixtures" }],
  blockers: ["no invalid fixtures"], warnings: [], readyForOwned: false,
};

describe("CLI presentation contracts", () => {
  it("wraps audit evidence and actionable diagnostics in the sole JSON envelope", () => {
    const json = JSON.parse(formatCommandJson("rules-audit", [report]));
    expect(json).toMatchObject({ schemaVersion: 1, command: "rules-audit",
      outcome: "block", summary: { rules: 1, blocked: 1 } });
    expect(json.data[0].checks).toEqual(report.checks);
    expect(json.data[0].diagnostics).toMatchObject([{
      code: "EVIDENCE_FIXTURES", level: "error", ruleId: "safety/example",
      suggestedCommand: "jevcheck test",
    }]);
  });

  it("exposes command identity, outcome and full detailed data", () => {
    const parsed = JSON.parse(formatCommandJson("rules-audit", [report]));
    expect(parsed).toMatchObject({
      schemaVersion: 1, command: "rules-audit", outcome: "block",
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

  it("uses the same JSON envelope for invalid arguments", () => {
    const parsed = JSON.parse(formatCommandError("check", Error("unknown option: --oops")));
    expect(parsed).toMatchObject({ schemaVersion: 1, command: "check", outcome: "error", data: null });
    expect(parsed.diagnostics).toMatchObject([{ code: "INVALID_ARGUMENT" }]);
    expect(parsed.error.remediation).toBeTruthy();
    expect(requestedFormat(["coverage", "verify", "--", "node", "--format", "json"])).toBeUndefined();
  });

  it("treats owned blocked coverage as blocked rather than a semantic fallback", () => {
    const blocked: RuleEvidenceReport = {
      ...report, checks: [{ id: "coverage", status: "block",
        message: "deterministic CI check failed: unit; owned enforcement blocked" }],
      blockers: ["deterministic CI check failed"], readyForOwned: false,
    };
    expect(evidenceState(blocked)).toBe("blocked");
    expect(JSON.parse(formatCommandJson("rules-audit", [blocked])).summary.semanticFallback)
      .toBe(0);
  });

  it("matches fixture, drift, and robustness failure outcomes rather than relying on diagnostics", () => {
    const failed = JSON.parse(formatCommandJson("test", {
      tests: [{ passed: false }], diagnostics: [], stats: {},
    }));
    expect(failed.outcome).toBe("block");
    expect(failed.summary.failed).toBe(1);
    expect(failed.diagnostics[0].code).toBe("FIXTURE_GATE_FAILED");

    const drift = JSON.parse(formatCommandJson("test", {
      tests: [{ passed: true }], diagnostics: [],
      drift: { moved: [{ ruleId: "test" }], stale: [], added: [], removed: [] },
    }));
    expect(drift.outcome).toBe("block");

    const notRecorded = JSON.parse(formatCommandJson("test", {
      tests: [{ passed: true }], diagnostics: [], confirmationNotRecorded: "no confirmation fixtures",
    }));
    expect(notRecorded.outcome).toBe("block");

    const incomplete = JSON.parse(formatCommandJson("test", {
      cases: [], complete: false, flips: 0, diagnostics: [],
    }));
    expect(incomplete.outcome).toBe("block");
    expect(incomplete.diagnostics[0].code).toBe("ROBUSTNESS_INCOMPLETE");
  });

  it("matches parseArgs last-format-wins semantics for failures and help", () => {
    expect(requestedFormat(["inspect", "--format", "stylish", "--format", "json", "--oops"])).toBe("json");
    expect(requestedFormat(["inspect", "--format", "json", "--format", "stylish", "--oops"])).toBeUndefined();
    expect(requestedFormat(["inspect", "--format", "json", "--format", "sarif"])).toBeUndefined();
  });

  it("keeps the last parsed valid JSON format when a later override is malformed", () => {
    expect(requestedFormat(["inspect", "--format", "json", "--format", "--help"])).toBe("json");
    expect(requestedFormat(["inspect", "--format", "json", "--format", "bogus"])).toBe("json");
    expect(requestedFormat(["inspect", "--format", "json", "--format", "stylish"])).toBeUndefined();
    expect(requestedFormat(["inspect", "--format", "json", "--format", "sarif"])).toBeUndefined();
  });

  it("returns CONFIG_ERROR for configuration validation rather than INVALID_ARGUMENT", () => {
    const error = new CliConfigError(new Error("sample/coverage.threshold must be between 0 and 1"));
    const parsed = JSON.parse(formatCommandError("check", error));
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    expect(parsed.error.remediation).toContain("rule configuration");
  });

  it("keeps rule, failed checks and remediation in fail-closed JSON errors", () => {
    const error = new OwnedRuleEvidenceError("Rule safety/example cannot be owned", report);
    const parsed = JSON.parse(formatCommandError("check", error));
    expect(parsed).toMatchObject({
      command: "check", outcome: "error",
      error: { code: "OWNED_RULE_EVIDENCE_BLOCKED", ruleId: "safety/example" },
      data: { evidenceReports: [{ ruleId: "safety/example", blockers: ["no invalid fixtures"] }] },
    });
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "EVIDENCE_FIXTURES", ruleId: "safety/example",
        suggestedCommand: "jevcheck test" }),
    ]));
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
    expect(JSON.parse(formatCommandJson("inspect", value)).data.inspections[0].request.state.code)
      .toBe("private-request");
  });
});
