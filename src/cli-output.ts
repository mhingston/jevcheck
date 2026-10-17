import type { Diagnostic, RuleEvidenceCheck, RuleEvidenceReport } from "./types.js";

export type OutputFormat = "stylish" | "json" | "json-v2" | "sarif";
export interface CliDiagnostic {
  code: string;
  level: "warning" | "error";
  message: string;
  path?: string;
  ruleId?: string;
  remediation?: string;
  suggestedCommand?: string;
}
export function evidenceState(report: RuleEvidenceReport): string {
  if (report.execution === "inapplicable") return "inapplicable";
  const coverage = report.checks.find((check) => check.id === "coverage");
  // Owned rules fail closed on blockers; they do not fall back to judging.
  if (report.currentStatus === "owned" && report.blockers.length) return "blocked";
  if (report.execution === "covered")
    return /passing CI commands for all coveredBy checks/i.test(coverage?.message ?? "") ? "ci-verified" : "reviewed-only";
  if (coverage && /fallback|failed|stale|unverified|missing/i.test(coverage.message)) return "semantic-fallback";
  return report.blockers.length ? "blocked" : "semantic";
}
export function evidenceRemediation(check: RuleEvidenceCheck): Pick<CliDiagnostic, "remediation" | "suggestedCommand"> {
  if (check.status === "pass") return {};
  switch (check.id) {
    case "coverage":
      if (/stale|missing coverage fingerprints|not been explicitly reviewed/i.test(check.message))
        return { remediation: "Review and re-record current coverage fingerprints.", suggestedCommand: "jevcheck coverage record --attest-reviewed" };
      return { remediation: "Run passing coveredBy checks via coverage verify in the same trusted GitHub Actions job and revision; fix failing checks first." };
    case "fixtures": return { remediation: "Add or fix valid and invalid fixtures.", suggestedCommand: "jevcheck test" };
    case "calibration": return { remediation: "Re-record calibration after passing fixture tests.", suggestedCommand: "jevcheck test --record" };
    case "confirmation": return { remediation: "Re-run untouched confirmation fixtures.", suggestedCommand: "jevcheck test --confirm" };
    case "mutation": return { remediation: "Address mutation recall misses.", suggestedCommand: "jevcheck recall" };
    case "robustness": return { remediation: "Resolve robustness failures.", suggestedCommand: "jevcheck test --robustness" };
    case "drift": return { remediation: "Resolve current drift.", suggestedCommand: "jevcheck test --drift" };
    case "source":
    case "architecture-decision": return { remediation: "Review rule source/ADR status, provenance and fingerprints." };
    case "applicability": return { remediation: "Review projectWhen for the selected revision." };
    default: return { remediation: "Review this evidence gate before ownership." };
  }
}
export function evidenceDiagnostics(report: RuleEvidenceReport): CliDiagnostic[] {
  return report.checks.filter((c) => c.status !== "pass").map((check) => ({
    code: "EVIDENCE_" + check.id.toUpperCase().replaceAll("-", "_"),
    level: check.status === "block" ? "error" as const : "warning" as const,
    message: check.message,
    ruleId: report.ruleId,
    ...evidenceRemediation(check),
  }));
}
export function decorateDiagnostic(d: Diagnostic): CliDiagnostic {
  return {
    code: d.code ?? "EVALUATION_DIAGNOSTIC",
    level: d.level, message: d.message,
    ...(d.path ? { path: d.path } : {}),
    ...(d.ruleId ? { ruleId: d.ruleId } : {}),
    ...(d.code === "incomplete-evaluation" ? {
      remediation: "Fix parser/selector or narrow rule scope to supported languages.",
      suggestedCommand: "jevcheck inspect --verbose",
    } : {}),
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function auditJson(reports: readonly RuleEvidenceReport[]) {
  return reports.map((report) => ({
    ...report, state: evidenceState(report),
    outcome: report.execution === "inapplicable" ? "pass" :
      report.blockers.length ? "block" : report.warnings.length ? "warn" : "pass",
    diagnostics: evidenceDiagnostics(report),
  }));
}
export function formatCommandJson(command: string, value: unknown, format: OutputFormat): string {
  const data = command === "rules-audit" && Array.isArray(value)
    ? auditJson(value as RuleEvidenceReport[])
    : object(value) && Array.isArray(value.diagnostics)
      ? { ...value, diagnostics: (value.diagnostics as Diagnostic[]).map(decorateDiagnostic) }
      : value;
  if (format === "json") return JSON.stringify(data, null, 2);
  let outcome: "pass" | "warn" | "block" = "pass";
  let summary: Record<string, number> = {};
  let diagnostics: CliDiagnostic[] = [];
  if (command === "rules-audit" && Array.isArray(data)) {
    const reports = data as ReturnType<typeof auditJson>;
    const active = reports.filter((r) => r.execution !== "inapplicable");
    const blocked = active.filter((r) => r.blockers.length > 0).length;
    const warnings = active.filter((r) => r.warnings.length > 0).length;
    outcome = blocked ? "block" : warnings ? "warn" : "pass";
    summary = { rules: reports.length, blocked, warnings,
      ready: active.filter((r) => r.readyForOwned).length,
      inapplicable: reports.length - active.length,
      reviewedOnly: reports.filter((r) => r.state === "reviewed-only").length,
      ciVerified: reports.filter((r) => r.state === "ci-verified").length,
      semanticFallback: reports.filter((r) => r.state === "semantic-fallback").length };
    diagnostics = reports.flatMap((r) => r.diagnostics);
  } else if (object(data) && Array.isArray(data.findings)) {
    const findings = data.findings as Array<{ blocking: boolean }>;
    diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics as CliDiagnostic[] : [];
    const blocking = findings.filter((x) => x.blocking).length;
    const errors = diagnostics.filter((x) => x.level === "error").length;
    const stats = object(data.stats) ? data.stats : {};
    const replayMisses = Number(stats.replayMisses ?? 0);
    summary = { findings: findings.length, blocking, errors, replayMisses,
      files: Number(stats.filesChecked ?? 0) };
    outcome = blocking || errors || replayMisses ? "block" : findings.length || diagnostics.length ? "warn" : "pass";
  } else if (command === "test" && object(data) && Array.isArray(data.tests)) {
    const tests = data.tests as Array<{ passed: boolean }>;
    diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics as CliDiagnostic[] : [];
    const failed = tests.filter((t) => !t.passed).length;
    const errors = diagnostics.filter((d) => d.level === "error").length;
    const incomplete = Boolean(data.confirmationNotRecorded || data.calibrationNotRecorded || data.evidenceNotRecorded);
    const drift = object(data.drift) ? data.drift : undefined;
    const driftChanged = drift ? ["moved", "stale", "added", "removed"].some((key) =>
      Array.isArray(drift[key]) && (drift[key] as unknown[]).length > 0) : false;
    outcome = failed || errors || incomplete || driftChanged ? "block" :
      diagnostics.length || tests.some((t) => (t as { thinMargin?: boolean }).thinMargin) ? "warn" : "pass";
    summary = { fixtures: tests.length, failed, errors, incomplete: incomplete ? 1 : 0,
      driftChanged: driftChanged ? 1 : 0 };
    if (failed) diagnostics.push({ code: "FIXTURE_GATE_FAILED", level: "error",
      message: failed + " fixture(s) did not meet expectations.",
      remediation: "Review failed fixture evidence and repeat the fixture test.",
      suggestedCommand: "jevcheck test" });
  } else if (command === "test" && object(data) && Array.isArray(data.cases)) {
    diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics as CliDiagnostic[] : [];
    const complete = data.complete === true;
    const flips = Number(data.flips ?? 0);
    outcome = !complete || diagnostics.some((d) => d.level === "error") ? "block" : flips ? "warn" : "pass";
    summary = { cases: data.cases.length, flips, incomplete: complete ? 0 : 1 };
    if (!complete) diagnostics.push({ code: "ROBUSTNESS_INCOMPLETE", level: "error",
      message: "Robustness evidence is incomplete.",
      remediation: "Resolve missing evaluations and rerun robustness fixtures.",
      suggestedCommand: "jevcheck test --robustness" });
  } else if (command === "coverage-verify" && object(data)) {
    outcome = data.status === "passed" ? "pass" : "block";
    summary = { checks: 1, failed: data.status === "passed" ? 0 : 1 };
    if (outcome === "block") diagnostics = [{ code: "COVERAGE_CHECK_FAILED", level: "error",
      message: "Deterministic CI verification failed.",
      remediation: "Fix the check and rerun coverage verify in the same GitHub Actions job." }];
  } else if (command === "inspect" && object(data)) {
    const rules = Array.isArray(data.rules) ? data.rules as Array<{execution:string}> : [];
    diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics as CliDiagnostic[] : [];
    const errors = diagnostics.filter((d) => d.level === "error").length;
    summary = { rules: rules.length,
      semantic: rules.filter((r) => r.execution === "semantic").length,
      covered: rules.filter((r) => r.execution === "covered").length,
      inapplicable: rules.filter((r) => r.execution === "inapplicable").length,
      candidates: Array.isArray(data.inspections) ? data.inspections.length : 0, errors };
    outcome = errors ? "block" : diagnostics.length ? "warn" : "pass";
  } else {
    diagnostics = object(data) && Array.isArray(data.diagnostics) ? data.diagnostics as CliDiagnostic[] : [];
    const errors = diagnostics.filter((d) => d.level === "error").length;
    outcome = errors ? "block" : diagnostics.length ? "warn" : "pass";
    summary = { results: Array.isArray(data) ? data.length : 1, errors };
  }
  return JSON.stringify({ schemaVersion: 2, command, outcome, summary, diagnostics, data }, null, 2);
}
export function requestedFormat(argv: readonly string[]): "json" | "json-v2" | undefined {
  const end = argv.indexOf("--");
  const args = end < 0 ? argv : argv.slice(0, end);
  let selected: string | undefined;
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] === "--format") {
      // parseArgs honours the last --format, including a later non-JSON override.
      selected = args[++i];
    }
  }
  return selected === "json" || selected === "json-v2" ? selected : undefined;
}
export function requestedCommand(argv: readonly string[]): string {
  if (argv[0] === "rules" && argv[1] === "audit") return "rules-audit";
  if (argv[0] === "coverage" && (argv[1] === "record" || argv[1] === "verify"))
    return "coverage-" + argv[1];
  return ["test","list","inspect","baseline","record","replay","recall"].includes(argv[0] ?? "")
    ? argv[0]! : "check";
}
export function formatCommandError(command: string, error: unknown, format: "json" | "json-v2"): string {
  const message = error instanceof Error ? error.message : String(error);
  const invalid = /unknown option|requires a value|--format|only valid|does not accept|choose either|requires --|unknown rule id|must be/i.test(message);
  const missing = /ENOENT|config file|cannot read/i.test(message);
  const diagnostic: CliDiagnostic = {
    code: invalid ? "INVALID_ARGUMENT" : missing ? "CONFIG_ERROR" : "COMMAND_FAILED",
    level: "error", message,
    remediation: invalid ? "Check CLI flags using jevcheck --help." :
      missing ? "Check the config path and required files." :
      "Correct the command, configuration or runtime environment before retrying.",
  };
  return JSON.stringify(format === "json-v2"
    ? { schemaVersion: 2, command, outcome: "error", summary: { errors: 1 },
      diagnostics: [diagnostic], error: diagnostic, data: null }
    : { command, outcome: "error", summary: { errors: 1 },
      diagnostics: [diagnostic], error: diagnostic }, null, 2);
}
