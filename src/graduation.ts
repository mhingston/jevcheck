import type {
  JevCheckRule,
  RuleEvidenceReport,
} from "./types.js";

/** Keeps failed ownership gates machine-readable without weakening fail-closed enforcement. */
export class OwnedRuleEvidenceError extends Error {
  constructor(message: string, public readonly report: RuleEvidenceReport) {
    super(message);
    this.name = "OwnedRuleEvidenceError";
  }
}

export function assertOwnedRuleEvidence(
  rules: readonly JevCheckRule[],
  reports: readonly RuleEvidenceReport[] | undefined,
): void {
  const byRule = new Map((reports ?? []).map((report) => [report.ruleId, report]));

  for (const rule of rules) {
    if ((rule.status ?? "shadow") !== "owned") continue;

    const report = byRule.get(rule.id);
    if (!report) {
      const message = "no rule evidence report supplied";
      throw new OwnedRuleEvidenceError(
        "Rule " + rule.id + " cannot be owned:\n- " + message,
        {
          ruleId: rule.id, currentStatus: "owned", execution: "semantic",
          checks: [{ id: "evidence", status: "block", message }],
          blockers: [message], warnings: [], readyForOwned: false,
        },
      );
    }

    if (!report.readyForOwned || report.blockers.length > 0) {
      const blockers = report.blockers.length
        ? report.blockers
        : ["rule evidence is not ready for owned status"];
      throw new OwnedRuleEvidenceError(
        "Rule " + rule.id + " cannot be owned:\n" +
          blockers.map((message) => "- " + message).join("\n"),
        report,
      );
    }
  }
}
