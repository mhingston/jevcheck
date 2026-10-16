import { minimatch } from "minimatch";
import { describeProjectCondition, projectConditionMatches } from "./applicability.js";
import type { JevCheckRule, RuleEvidenceReport } from "./types.js";

export type RuleExecution = NonNullable<RuleEvidenceReport["execution"]>;

export interface RuleExecutionDecision {
  execution: RuleExecution;
  reason: string;
  fileApplicable: boolean;
}

export function ruleAppliesToFile(rule: JevCheckRule, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const includes = rule.files ?? ["**/*"];
  if (!includes.some((pattern) => minimatch(normalized, pattern, { dot: true }))) return false;
  return !(rule.exclude ?? []).some((pattern) => minimatch(normalized, pattern, { dot: true }));
}

/**
 * One policy decision for both the enforcement loop and provider-free inspection.
 * Supplied reports are authoritative: they already incorporate current project
 * applicability, ADR status and fingerprinted deterministic coverage.
 *
 * Without reports, projectWhen is still evaluated at the requested project
 * root. Callers with ADR/coverage policy must first resolve evidence reports.
 */
export function createRuleExecutionResolver(
  reports: readonly RuleEvidenceReport[] = [],
  projectRoot = process.cwd(),
  mode: "enforce" | "measure" = "enforce",
): (rule: JevCheckRule, path: string, options?: { ignoreFileScope?: boolean }) => Promise<RuleExecutionDecision> {
  const reportById = new Map(reports.map((report) => [report.ruleId, report]));
  const applicability = new Map<JevCheckRule, Promise<boolean>>();

  return async (rule, path, options = {}) => {
    if (!options.ignoreFileScope && !ruleAppliesToFile(rule, path)) {
      return {
        execution: "inapplicable",
        reason: "file is outside rule files/exclude scope",
        fileApplicable: false,
      };
    }

    if (mode === "measure") {
      return { execution: "semantic", reason: "measurement bypasses runtime policy", fileApplicable: true };
    }

    const report = reportById.get(rule.id);
    if (report) {
      const execution = report.execution ?? "semantic";
      const decisive = execution === "inapplicable"
        ? report.checks.find((check) =>
            (check.id === "architecture-decision" && check.status === "block") ||
            (check.id === "applicability" && check.message.startsWith("not applicable:")))
        : execution === "covered"
          ? report.checks.find((check) => check.id === "coverage")
          : report.checks.find((check) => check.id === "coverage") ??
            report.checks.find((check) => check.id === "applicability");
      return {
        execution,
        reason: decisive?.message ??
          (execution === "semantic" ? "eligible for semantic judgement" : "runtime policy: " + execution),
        fileApplicable: true,
      };
    }

    if (rule.projectWhen) {
      let pending = applicability.get(rule);
      if (!pending) {
        pending = projectConditionMatches(rule.projectWhen, projectRoot);
        applicability.set(rule, pending);
      }
      if (!(await pending)) {
        return {
          execution: "inapplicable",
          reason: "not applicable: " + describeProjectCondition(rule.projectWhen),
          fileApplicable: true,
        };
      }
    }
    return { execution: "semantic", reason: "eligible for semantic judgement", fileApplicable: true };
  };
}
