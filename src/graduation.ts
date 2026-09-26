import type {
  JevCheckRule,
  RuleEvidenceReport,
} from "./types.js";

export function assertOwnedRuleEvidence(
  rules: readonly JevCheckRule[],
  reports: readonly RuleEvidenceReport[] | undefined,
): void {
  const byRule = new Map((reports ?? []).map((report) => [report.ruleId, report]));

  for (const rule of rules) {
    if ((rule.status ?? "shadow") !== "owned") continue;

    const report = byRule.get(rule.id);
    if (!report) {
      throw new Error(
        "Rule " +
          rule.id +
          " cannot be owned:\n- no rule evidence report supplied",
      );
    }

    if (!report.readyForOwned || report.blockers.length > 0) {
      const blockers = report.blockers.length
        ? report.blockers
        : ["rule evidence is not ready for owned status"];
      throw new Error(
        "Rule " +
          rule.id +
          " cannot be owned:\n" +
          blockers.map((message) => "- " + message).join("\n"),
      );
    }
  }
}
