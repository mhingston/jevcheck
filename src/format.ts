import type { CheckResult, FixtureRunResult } from "./types.js";

export function formatStylish(result: CheckResult): string {
  const lines: string[] = [];
  const findings = [...result.findings].sort(
    (a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.ruleId.localeCompare(b.ruleId),
  );

  for (const finding of findings) {
    const kind = finding.blocking ? "error" : finding.status === "shadow" ? "shadow" : finding.severity;
    lines.push(
      finding.path +
        ":" +
        finding.startLine +
        "-" +
        finding.endLine +
        "  " +
        kind.padEnd(7) +
        "  " +
        finding.ruleId +
        "  p=" +
        finding.probability.toFixed(2) +
        " >= " +
        finding.threshold.toFixed(2),
    );
    if (finding.why) lines.push("  " + finding.why);
    if (finding.source) lines.push("  source: " + finding.source);
  }

  for (const diagnostic of result.diagnostics) {
    const location = [diagnostic.path, diagnostic.ruleId].filter(Boolean).join(" ");
    lines.push(
      (diagnostic.level === "error" ? "error" : "warning") +
        (location ? " " + location : "") +
        ": " +
        diagnostic.message,
    );
  }

  if (!findings.length && !result.diagnostics.length) lines.push("No findings.");

  const blocking = findings.filter((finding) => finding.blocking).length;
  lines.push(
    result.findings.length +
      " finding(s), " +
      blocking +
      " blocking; " +
      result.stats.filesChecked +
      " file(s), " +
      result.stats.candidatesChecked +
      " candidate(s), " +
      result.stats.requests +
      " request(s), " +
      result.stats.cacheHits +
      " cache hit(s)",
  );

  return lines.join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatFixtureStylish(result: FixtureRunResult): string {
  const lines = result.tests.map((test) => {
    return (
      (test.passed ? "PASS" : "FAIL") +
      "  " +
      test.ruleId +
      "  " +
      test.expected +
      "  " +
      test.path +
      "  max p=" +
      test.maxProbability.toFixed(2) +
      " threshold=" +
      test.threshold.toFixed(2)
    );
  });

  for (const diagnostic of result.diagnostics) {
    lines.push(
      diagnostic.level.toUpperCase() +
        "  " +
        (diagnostic.ruleId ? diagnostic.ruleId + "  " : "") +
        diagnostic.message,
    );
  }

  const failures = result.tests.filter((test) => !test.passed).length;
  lines.push(result.tests.length + " fixture(s), " + failures + " failure(s)");
  return lines.join("\n");
}
